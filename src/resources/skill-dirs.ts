import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isCliOwnedSkillName, ownedSkillFiles, prunedWhole, removeOwnedFiles, skillsGuardBase } from '../builtin-skills.js';
import { locate, writableDir, writesOf, type Install } from '../locate.js';
import { realHost, toolHome, type Host } from '../tool-home.js';
import { isToolId, skillsFollowSession } from '../tools.js';
import { resolveBaseDir, type LocalConfig, type State } from '../types.js';
import { listDirs, pathExists, remove } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';
import { forgetDelivered, judgeRemoval, keepsTrackedCopy, recordedUnder, type DeliveryLedger } from './delivered-copies.js';
import { mayDeleteSkillCopy, skillOrigin } from './skills.js';

type CheckoutRecord = NonNullable<State['lastPullByWorkspace']>[string];

/** Tool → the absolute directories teamai writes its skills into, for each tool whose write gates are met. */
export type SkillDirs = NonNullable<CheckoutRecord['skillDirs']>;

/** Tool → its home, for each tool whose skills follow the session. */
export type SessionToolHomes = NonNullable<CheckoutRecord['sessionToolHomes']>;

/** Where every tool of `install` whose write gates are met takes skills now, session-following tools included. */
export async function skillDirsOf(install: Install, host: Host = realHost()): Promise<SkillDirs> {
  const located = await Promise.all(Object.keys(install.toolPaths).sort()
    .map(async (tool) => ({ tool, where: await locate(tool, 'skills', install, host) })));
  const dirs: SkillDirs = {};
  for (const { tool, where } of located) if (writableDir(where) !== null) dirs[tool] = writesOf(where);
  return dirs;
}

export function sessionToolHomesOf(current: SkillDirs, host: Host = realHost()): SessionToolHomes {
  return Object.fromEntries(Object.keys(current).filter(isToolId).filter(skillsFollowSession).map((tool) => [tool, toolHome(tool, host)]));
}

/**
 * Whether the tools take skills where the last full pull recorded writing
 * them. A tool whose skills follow the session is compared by its home, as
 * each session may name another directory under it.
 */
export function skillDirsUnmoved(
  recorded: { readonly skillDirs: SkillDirs; readonly sessionToolHomes?: SessionToolHomes },
  current: SkillDirs,
  host: Host = realHost(),
): boolean {
  const asDirs = (homes: SessionToolHomes): SkillDirs => Object.fromEntries(Object.entries(homes).map(([tool, dir]) => [tool, [dir]]));
  return sameSkillDirs(recorded.skillDirs, withoutSessionTools(current, skillsFollowSession), host)
    && sameSkillDirs(asDirs(recorded.sessionToolHomes ?? {}), asDirs(sessionToolHomesOf(current, host)), host);
}

function withoutSessionTools(dirs: SkillDirs, followsSession: (tool: string) => boolean): SkillDirs {
  return Object.fromEntries(Object.entries(dirs).filter(([tool]) => !followsSession(tool)));
}

/** Whether two answers name the same directories for the same tools, compared as paths on `host`. */
export function sameSkillDirs(recorded: SkillDirs, current: SkillDirs, host: Pick<Host, 'path' | 'platform'> = realHost()): boolean {
  const tools = Object.keys(current);
  if (Object.keys(recorded).length !== tools.length) return false;
  return tools.every((tool) => {
    const before = recorded[tool];
    if (before === undefined) return false;
    const after = new Set(current[tool].map((dir) => comparable(dir, host)));
    return before.length === after.size && before.every((dir) => after.has(comparable(dir, host)));
  });
}

function comparable(dir: string, host: Pick<Host, 'path' | 'platform'>): string {
  const resolved = host.path.resolve(dir);
  return host.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export type SkillDirRelease = { readonly dir: string; readonly tool: string; readonly currentDir: string };

/**
 * What a full pull records as `skillDirs` and `formerSkillDirs`, and which old
 * directories it releases, decided over every tool at once: a directory any
 * tool takes skills from now, or an incomplete tool keeps on record, is never
 * released. `incomplete` names the tools that did not take every skill or the
 * built-in stub this pull: they keep their previous directories on record. A
 * tool that takes skills nowhere now keeps its previous directories as
 * `former`, out of `record`; they are released once it takes skills elsewhere.
 * Directories are compared by their `realDirs` entry where they have one, so a
 * link to a directory is that directory.
 */
export function settleSkillDirs({ previous, former, current, incomplete, realDirs, followsSession, host }: {
  readonly previous: SkillDirs | undefined;
  readonly former: SkillDirs | undefined;
  readonly current: SkillDirs;
  readonly incomplete: ReadonlySet<string>;
  readonly realDirs: ReadonlyMap<string, string>;
  readonly followsSession: (tool: string) => boolean;
  readonly host: Pick<Host, 'path' | 'platform'>;
}): { readonly record: SkillDirs; readonly former: SkillDirs; readonly release: readonly SkillDirRelease[] } {
  const keyOf = (dir: string): string => comparable(realDirs.get(dir) ?? dir, host);
  const before: SkillDirs = { ...former, ...previous };
  const next: SkillDirs = {};
  for (const [tool, dirs] of Object.entries(current)) {
    const writes = new Set(dirs.map(keyOf));
    const earlier = incomplete.has(tool) ? (before[tool] ?? []).filter((dir) => !writes.has(keyOf(dir))) : [];
    next[tool] = [...earlier, ...dirs];
  }
  const nextFormer = Object.fromEntries(Object.entries(before).filter(([tool]) => !(tool in current)));
  const live = new Set([...Object.values(current), ...[...incomplete].map((tool) => before[tool] ?? [])].flat().map(keyOf));
  const release = new Map<string, SkillDirRelease>();
  for (const [tool, dirs] of Object.entries(before)) {
    const currentDirs = current[tool];
    if (currentDirs === undefined || incomplete.has(tool) || followsSession(tool)) continue;
    for (const dir of dirs) {
      const key = keyOf(dir);
      if (!live.has(key) && !release.has(key)) release.set(key, { dir, tool, currentDir: currentDirs[0] });
    }
  }
  return { record: withoutSessionTools(next, followsSession), former: withoutSessionTools(nextFormer, followsSession), release: [...release.values()] };
}

/**
 * Release what `settleSkillDirs` decides and return what to record: its
 * `skillDirs` and `formerSkillDirs`, and the `sessionToolHomes` of each
 * session-following tool that took every skill. An incomplete one keeps the
 * home recorded before.
 *
 * Only a copy the delivery record holds goes, and only unchanged
 * (`judgeRemoval`); an edited copy is kept with its record and named, and a
 * copy teamai has no record of is never touched. A crash halfway leaves the
 * record's `skillDirs` unchanged, so the next full pull repeats the release;
 * a second run with nothing moved does nothing.
 */
export async function releaseMovedSkillDirs({ previous, current, incomplete, ledger, localConfig, scopeLabel, host = realHost() }: {
  readonly previous: Pick<CheckoutRecord, 'skillDirs' | 'formerSkillDirs' | 'sessionToolHomes'> | undefined;
  readonly current: SkillDirs;
  readonly incomplete: ReadonlySet<string>;
  readonly ledger: DeliveryLedger;
  readonly localConfig: LocalConfig;
  readonly scopeLabel: string;
  readonly host?: Host;
}): Promise<{ readonly skillDirs: SkillDirs; readonly formerSkillDirs: SkillDirs; readonly sessionToolHomes: SessionToolHomes }> {
  const realDirs = await realDirsOf([...Object.values(previous?.skillDirs ?? {}), ...Object.values(previous?.formerSkillDirs ?? {}), ...Object.values(current)].flat());
  const { record, former, release } = settleSkillDirs({
    previous: previous?.skillDirs, former: previous?.formerSkillDirs, current, incomplete, realDirs, followsSession: skillsFollowSession, host,
  });
  for (const { dir, tool, currentDir } of release) {
    let released = 0;
    for (const name of await listDirs(dir)) {
      const skillDir = path.join(dir, name);
      if (isCliOwnedSkillName(name)) {
        if (prunedWhole(await removeOwnedFiles(skillDir, await ownedSkillFiles(name), await skillsGuardBase(resolveBaseDir(localConfig), dir)))) released++;
        continue;
      }
      if (recordedUnder(ledger.previous ?? {}, skillDir).length === 0) continue;
      const removal = await judgeRemoval(ledger.previous, skillDir, skillOrigin(localConfig.repo.localPath, name), ledger.otherRecords);
      switch (removal) {
        case 'remove':
          if (await keepsTrackedCopy(skillDir) || !await mayDeleteSkillCopy(localConfig, skillDir)) break;
          await remove(skillDir);
          forgetDelivered(ledger.hashes, skillDir);
          released++;
          break;
        case 'edited':
          warnOnce(`[${scopeLabel}] Kept ${skillDir}: ${tool} takes skills from ${currentDir} now, but you changed this copy. Delete it when you no longer need it.`);
          break;
        case 'notTeamais':
          break;
        default: {
          const unhandled: never = removal;
          return unhandled;
        }
      }
    }
    for (const file of recordedUnder(ledger.hashes, dir)) {
      if (!await pathExists(file)) forgetDelivered(ledger.hashes, file);
    }
    if (released > 0) log.info(`[${scopeLabel}] Removed ${released} skill copy(ies) from ${dir}: ${tool} takes skills from ${currentDir} now.`);
  }
  const sessionToolHomes: SessionToolHomes = {};
  for (const [tool, home] of Object.entries(sessionToolHomesOf(current, host))) {
    sessionToolHomes[tool] = incomplete.has(tool) ? (previous?.sessionToolHomes?.[tool] ?? home) : home;
  }
  return { skillDirs: record, formerSkillDirs: former, sessionToolHomes };
}

/** The real path of each of `dirs` that exists. */
async function realDirsOf(dirs: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const real = new Map<string, string>();
  await Promise.all([...new Set(dirs)].map(async (dir) => {
    try {
      real.set(dir, await realpath(dir));
    } catch (e) {
      if (!(typeof e === 'object' && e !== null && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) throw e;
    }
  }));
  return real;
}
