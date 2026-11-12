/**
 * Watches the sandboxes a world's command makes while it runs, and judges each one's environment with
 * `judgeSandboxEnv`: containers and sbx sandboxes tied to the world, and on Linux each bwrap whose arguments name a world
 * path. Values are read and compared in memory only; what is written (observed.jsonl, the `[verify] observed` lines)
 * holds names. Loaded only once a sandbox place opens or closes in a HOME of the world during the command (target.ts).
 * A sandbox of the world it lists but cannot read is NOT OBSERVED, never left out.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { collectEnvSecrets } from '@teamai/shared/redact';
import type { JsonValue } from '@teamai/shared/json';
import { parseYaml } from '@teamai/shared/yaml';
import { SIGN_INS } from '@teamai/tool-definitions';
import { z } from 'zod';
import { journal } from '../../packages/runtime-sandbox/src/journal.js';
import { sandboxJournalRoot } from '../../packages/runtime-sandbox/src/journal-root.js';
import { CONTAINER_ENGINES } from '../../packages/runtime-sandbox/src/options.js';
import { PROVIDER_COMMANDS } from '../../packages/runtime-sandbox/src/provider-commands.js';
import { journalOfSbxName } from './leftovers/sbx.js';
import { declaredCredentialNames, judgeSandboxEnv, parseEnviron, type EnvVerdict } from './secrets.js';
import { CANARY_NAME, worldHomes, type World } from './world.js';

const run = promisify(execFile);
const POLL_MS = 500;

/** Every process's environment inside a sandbox, one block per process, blocks split by an empty entry. Never printed. */
const ENVIRONS = 'for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null && printf "\\0\\0"; done';

/** What one sandbox showed over a command: how many environments were read, and every leaking name among them. */
interface Seen {
  readonly what: string;
  read: number;
  names: Set<string>;
}

/**
 * The credential names a step of the world may carry: every `credentials` mapping in the YAML under each HOME's and
 * project's `.teamai` (driver definitions, a member's driver settings), and the tools' sign-in variables, which teamai
 * gives a runtime entry that declares none. Each file that is not YAML is named: what only it declares counts as undeclared.
 */
function declaredCredentials(world: World) {
  const declared = new Set<string>(Object.values(SIGN_INS).flatMap((signIn) => [...signIn.variables, ...('alongside' in signIn ? signIn.alongside : [])]));
  const unreadable: string[] = [];

  const walk = (dir: string, depth: number): void => {
    for (const entry of depth > 8 || !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') walk(full, depth + 1);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
        let text: JsonValue;

        try {
          text = parseYaml(fs.readFileSync(full, 'utf8'));
        } catch {
          unreadable.push(path.relative(world.dir, full));
          continue;
        }

        for (const name of declaredCredentialNames(text)) declared.add(name);
      }
    }
  };

  for (const root of [...worldHomes(world), world.project, ...(world.members ?? []).map((member) => member.project)]) walk(path.join(root, '.teamai'), 0);

  return { declared, unreadable };
}

/** Each environment `ENVIRONS` printed. */
function environsOf(stdout: string): Array<Map<string, string>> {
  return stdout.split('\0\0').flatMap((block) => (block === '' ? [] : [parseEnviron(block)]));
}

/** What `argv` printed on this machine, or undefined when it could not run or failed: the observer's one effect on a sandbox. */
async function listedHere(argv: readonly string[]): Promise<string | undefined> {
  const [command = 'true', ...args] = argv;

  try {
    return (await run(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 ** 2 })).stdout;
  } catch {
    return undefined;
  }
}

const SbxListedSchema = z.array(z.looseObject({ name: z.string(), status: z.string().optional() }));

/** A process as /proc lists it: its pid, its parent's, and its arguments. */
export interface ProcEntry {
  readonly pid: string;
  readonly ppid: string;
  readonly args: readonly string[];
}

/**
 * Each bwrap step in `procs` whose arguments name a path under one of `roots`: its outermost bwrap, and the first of
 * its descendants that are not bwrap, whose environment is the step's. A bwrap inside another is that step's own.
 */
export function bwrapSteps(procs: readonly ProcEntry[], roots: readonly string[]): Array<{ bwrap: string; steps: string[] }> {
  const isBwrap = (args: readonly string[]): boolean => path.basename(args[0] ?? '') === 'bwrap';
  const bwrapPids = new Set(procs.flatMap((proc) => (isBwrap(proc.args) ? [proc.pid] : [])));
  const outermost = procs.filter((proc) => bwrapPids.has(proc.pid) && !bwrapPids.has(proc.ppid) && proc.args.some((arg) => roots.some((root) => arg.startsWith(root))));

  return outermost.flatMap((outer) => {
    for (let frontier = [outer.pid]; frontier.length > 0;) {
      const children = procs.filter((proc) => frontier.includes(proc.ppid));
      const first = children.filter((proc) => !isBwrap(proc.args));

      if (first.length > 0) return [{ bwrap: outer.pid, steps: first.map((proc) => proc.pid) }];
      frontier = children.map((proc) => proc.pid);
    }

    return [];
  });
}

/** Starts watching; `stop` takes a last look and answers the lines to show, and has written them to observed.jsonl. */
export function startObserver(world: World, { pass, label, listed = listedHere }: { pass: ReadonlyMap<string, string>; label: string; listed?: (argv: readonly string[]) => Promise<string | undefined> }) {
  const canary = world.env?.[CANARY_NAME] ?? '';
  const secrets = new Map([...Object.entries(collectEnvSecrets(process.env)), ...pass]);
  const { declared, unreadable } = declaredCredentials(world);
  const owners = new Set<string>(worldHomes(world).map((home) => journal(sandboxJournalRoot(home)).owner));
  const seen = new Map<string, Seen>();
  const unobserved = new Set<string>();
  const notRunning = new Map<string, string>();
  let sawSeatbelt = false;
  let enginesUp: Array<(typeof CONTAINER_ENGINES)[number]> | undefined;

  const judge = (key: string, what: string, environs: ReadonlyArray<ReadonlyMap<string, string>>): void => {
    const entry = seen.get(key) ?? { what, read: 0, names: new Set<string>() };
    seen.set(key, entry);

    for (const env of environs) {
      entry.read += 1;
      const verdict: EnvVerdict = judgeSandboxEnv({ env, canary, secrets, declared });

      if (verdict.kind === 'leak') for (const name of verdict.names) entry.names.add(name);
    }
  };

  const containers = async (): Promise<void> => {
    enginesUp ??= (await Promise.all(CONTAINER_ENGINES.map(async (engine) => ((await listed([PROVIDER_COMMANDS[engine], 'info', '--format', '{{.ServerVersion}}'])) === undefined ? [] : [engine])))).flat();

    for (const engine of enginesUp) {
      const command = PROVIDER_COMMANDS[engine];
      const lines = await listed([command, 'ps', '--filter', 'label=teamai.owner', '--format', '{{.ID}}\t{{.Names}}\t{{.Label "teamai.owner"}}']);

      if (lines === undefined) {
        unobserved.add(`${engine} containers, \`${engine} ps\` failed`);
        continue;
      }

      for (const line of lines.split('\n')) {
        const [id = '', name = '', owner = ''] = line.split('\t');

        if (id === '' || !owners.has(owner)) continue;
        const environs = await listed([command, 'exec', id, 'sh', '-c', ENVIRONS]);

        judge(`${engine}:${name}`, `${engine}:${name}`, environs === undefined ? [] : environsOf(environs));
      }
    }
  };

  const sbx = async (): Promise<void> => {
    const out = await listed([PROVIDER_COMMANDS.sbx, 'ls', '--json']);
    const parsed = out === undefined ? undefined : SbxListedSchema.safeParse(JSON.parse(out));

    for (const sandbox of parsed?.success === true ? parsed.data : []) {
      const owner = journalOfSbxName(sandbox.name);

      if (owner === undefined || !owners.has(owner)) continue;

      // `sbx exec` starts a stopped sandbox: only one listed as running is asked.
      if (sandbox.status !== 'running') {
        notRunning.set(sandbox.name, sandbox.status ?? 'in no state');
        continue;
      }

      const environs = await listed([PROVIDER_COMMANDS.sbx, 'exec', sandbox.name, 'sh', '-c', ENVIRONS]);

      judge(`sbx:${sandbox.name}`, `sbx:${sandbox.name}`, environs === undefined ? [] : environsOf(environs));
    }
  };

  /** On Linux, each bwrap whose arguments name a world path: the environment of its first descendant that is not bwrap. */
  const bwraps = (): void => {
    if (process.platform !== 'linux') {
      for (const member of world.members ?? []) if (member.machine === 'container') unobserved.add(`bwrap steps in @${member.name}'s container, the observer reads their environment from /proc on Linux only`);

      return;
    }

    const procs = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        const ppid = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1] ?? '';

        return [{ pid, ppid, args }];
      } catch {
        return [];
      }
    });

    for (const { bwrap, steps } of bwrapSteps(procs, [world.dir, world.tmp])) {
      for (const step of steps) {
        try {
          judge(`bwrap:${bwrap}`, `bwrap:${bwrap}`, [parseEnviron(fs.readFileSync(`/proc/${step}/environ`, 'utf8'))]);
        } catch {
          unobserved.add(`bwrap:${bwrap}'s environment, /proc/${step}/environ could not be read`);
        }
      }
    }
  };

  let polling: Promise<void> | undefined;

  const look = async (): Promise<void> => {
    try {
      await Promise.all([containers(), sbx()]);
      bwraps();
      // A place's record goes once it closes, so each look notes whether one runs on seatbelt.
      sawSeatbelt ||= worldHomes(world).some(usesSeatbelt);
    } catch (error) {
      unobserved.add(`a look at the sandboxes, ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      polling = undefined;
    }
  };

  const poll = (): Promise<void> => (polling ??= look());

  const timer = setInterval(() => void poll(), POLL_MS);

  return {
    async stop(): Promise<string[]> {
      clearInterval(timer);
      await polling;
      await poll();
      const at = new Date().toISOString();
      const records = [...seen.values()].map((entry) => ({ at, command: label, what: entry.what, read: entry.read, verdict: entry.names.size === 0 ? 'env ok' : 'ENV LEAK', names: [...entry.names].toSorted() }));

      for (const [name, status] of notRunning) if (!seen.has(`sbx:${name}`)) unobserved.add(`sbx:${name}'s environment, sbx listed it as ${status}, and only a running one is asked`);

      if (records.length > 0) fs.appendFileSync(path.join(world.dir, 'observed.jsonl'), records.map((record) => `${JSON.stringify(record)}\n`).join(''));

      return [
        ...records.map((record) => `[verify] observed ${record.what}: ${record.read === 0 ? 'NOT OBSERVED, no environment could be read' : record.names.length === 0 ? 'env ok' : `ENV LEAK ${record.names.join(', ')}`}`),
        ...[...unobserved].map((what) => `[verify] NOT OBSERVED: ${what}`),
        ...(sawSeatbelt ? ['[verify] seatbelt has no observer: the env check proves nothing for a seatbelt step'] : []),
        ...unreadable.map((file) => `[verify] ${file} is not YAML: a credential only it declares counts as undeclared`),
      ];
    },
  };
}

const PlaceOptionsSchema = z.looseObject({ options: z.looseObject({ provider: z.string().optional() }).optional() });

/** Whether a place the sandbox runtime recorded under `home` ran on seatbelt. */
function usesSeatbelt(home: string): boolean {
  const places = path.join(sandboxJournalRoot(home), 'places');

  return (fs.existsSync(places) ? fs.readdirSync(places) : []).some((name) => {
    if (!name.endsWith('.json')) return false;

    try {
      return PlaceOptionsSchema.parse(JSON.parse(fs.readFileSync(path.join(places, name), 'utf8'))).options?.provider === 'seatbelt';
    } catch {
      return false;
    }
  });
}
