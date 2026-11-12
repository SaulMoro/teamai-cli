import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { RUNTIME_PROTOCOL } from '@teamai/runtime-protocol';
import { resolvePathCommand } from '@teamai/shared/cli-path';
import { readRegularFile, readRegularFileNoLink } from '@teamai/shared/regular-file';
import { parseYaml } from '@teamai/shared/yaml';
import { teamaiBin, teamaiPackageDir } from '../../default-drivers.js';
import type { RunMode } from '../../launch-context.js';
import { isSymlink, RESOURCE_LAYOUTS, Resources, type ShippedFile } from '../../resources/resolver.js';
import { acceptTeamCommand } from '../../tool-instances.js';
import { getKnowledgeDir, getTeamaiHomeDir } from '../../types.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import type { WorkflowFailure } from '../types.js';
import { personalItem, teamTreeOf, type ResolvedDriver } from './definitions.js';

// ─── Where a step runtime comes from ─────────────────────
//
//  `tools` is built in: it launches the member's tools in teamai's own process, and `local` names it too. Any other
//  runtime is a resource, `runtimes/<name>.yaml` or the folder `runtimes/<name>/` with its `RUNTIME.yaml` and its code.
//  `use: <name>` takes the first of: the member's own ~/.teamai/runtimes/, the team repo's runtimes/ (and
//  runtimes/<namespace>/ for each active namespace), then teamai's own runtimes/ in its package; first by the exact name
//  in every layer, then as teamai-<name>. A team runtime is code a teammate pushed, so before its first spawn a person
//  accepts it: a folder at its revision, a file's command at the file's content. An attended run asks, and an
//  unattended one refuses.
//

/** The marker of a runtime folder, which the folder form holds beside its code. */
export const RUNTIME_MARKER = RESOURCE_LAYOUTS.runtimes.marker;

/** What a runtime's marker sets, in its file form (`runtimes/<x>.yaml`) and its folder form (`runtimes/<x>/RUNTIME.yaml`). */
const RuntimeMarkerSchema = z.object({
  protocol: z.number().int(),
  entry: z.union([
    z.string().min(1).transform((file) => ({ kind: 'path' as const, file })),
    z.object({ command: z.string().min(1) }).strict().transform(({ command }) => ({ kind: 'command' as const, command })),
    z.object({ bin: z.string().min(1) }).strict().transform(({ bin }) => ({ kind: 'bin' as const, bin })),
  ]),
  exec: z.boolean().optional(),
}).strict();

/** The layer a runtime was found in, which decides what a person accepts before it runs. */
export type RuntimeLayer = 'personal' | 'team' | 'teamai';

/** How teamai starts a runtime: the Node that runs teamai runs a built file of teamai's own package, or the runtime's executable runs. */
export type RuntimeLaunch = { readonly kind: 'node'; readonly file: string } | { readonly kind: 'executable'; readonly executable: string };

/**
 * What a person accepts before a team runtime first runs here: its folder at its revision, or its file's command at the
 * file's content. A member's own runtime and teamai's need nothing.
 */
export type RuntimeTrust = { readonly kind: 'none' } | { readonly kind: 'folder'; readonly dir: string } | { readonly kind: 'command'; readonly command: string };

/** A runtime that is an external program, as its marker declares it. */
export interface ExternalRuntime {
  readonly kind: 'external';
  /** The name its entry gives it with `use`, which messages and records name it by. */
  readonly name: string;
  /** The name of the resource found for it: `name` itself, or `teamai-<name>`. */
  readonly resource: string;
  readonly layer: RuntimeLayer;
  /** The marker file: the file form itself, or the folder's `RUNTIME.yaml`. */
  readonly marker: string;
  /** Where a message names it: its path in the team repo (`runtimes/t3/`), the member's file, or teamai's. */
  readonly location: string;
  readonly launch: RuntimeLaunch;
  /** `exec: false` when its marker says it runs no command, which a run that needs no AI tool reads without starting it. */
  readonly exec?: boolean;
  /** The sha256 of the file form's content, or the folder's revision (`runtimeRevision`). */
  readonly revision: string;
  readonly trust: RuntimeTrust;
}

/** Where a runtime was found: the built-in `tools`, or an external one. */
export type RuntimeSource = { readonly kind: 'builtin'; readonly name: 'tools' } | ExternalRuntime;

/**
 * What one layer gives for one name: the runtime; nothing; a definition that cannot run (`unusable`), named in
 * `failure`; or a definition that refuses the run outright, such as one reached through a link.
 */
type LayerLookup =
  | { readonly kind: 'found'; readonly source: ExternalRuntime }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly failure: WorkflowFailure }
  | { readonly kind: 'refused'; readonly failure: WorkflowFailure };

/** A definition of one name in one layer, as the lookup reads it before its marker is parsed. */
interface Definition {
  readonly layer: RuntimeLayer;
  readonly resource: string;
  readonly form: 'file' | 'folder';
  /** The file form itself, or the folder. */
  readonly at: string;
  readonly location: string;
  /** The marker's text, as the teamai layer holds it read; read from `at` otherwise. */
  readonly text?: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What a member does to fix a definition in `layer`. */
function fixOf(layer: RuntimeLayer): string {
  switch (layer) {
    case 'personal':
      return 'Fix the file and start again.';
    case 'team':
      return 'Fix it, push it, run teamai pull, and start again.';
    case 'teamai':
      return 'Reinstall teamai.';
    default: {
      const unhandled: never = layer;

      return unhandled;
    }
  }
}

/**
 * The runtime `definition` declares, or why it cannot run: its marker must parse, speak `RUNTIME_PROTOCOL`, and name an
 * entry its form allows that is there: a path inside the folder, an executable on PATH for a file of the member's or
 * the team's, a program of teamai's own package for teamai's.
 */
async function readDefinition(driver: ResolvedDriver, use: string, definition: Definition): Promise<LayerLookup> {
  const markerFile = definition.form === 'folder' ? path.join(definition.at, RUNTIME_MARKER) : definition.at;

  const unusable = (reason: string): LayerLookup => ({
    kind: 'unusable',
    failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "${use}", and ${definition.location} cannot run it: ${reason}. ${fixOf(definition.layer)}` },
  });

  let text = definition.text;

  if (text === undefined) {
    try {
      text = await readRegularFileNoLink(markerFile, 'utf8');
    } catch (error) {
      return unusable(`${definition.form === 'folder' ? RUNTIME_MARKER : 'the file'} cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return unusable(`it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  const parsed = RuntimeMarkerSchema.safeParse(raw);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;

    return unusable(`${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'not valid'}; a runtime sets protocol, entry and optionally exec`);
  }

  const marker = parsed.data;

  if (marker.protocol !== RUNTIME_PROTOCOL) return unusable(`it declares protocol ${marker.protocol}, and this teamai speaks protocol ${RUNTIME_PROTOCOL}`);
  const launched = await launchOf(definition, marker.entry);

  if (!launched.ok) return unusable(launched.reason);
  const revision = definition.form === 'folder' ? await runtimeRevision(definition.at) : sha256(text);

  return {
    kind: 'found',
    source: {
      kind: 'external', name: use, resource: definition.resource, layer: definition.layer, marker: markerFile, location: definition.location,
      launch: launched.launch, ...(marker.exec !== undefined && { exec: marker.exec }), revision, trust: launched.trust,
    },
  };
}

/** What a marker's `entry` names: a file inside its folder, an executable on PATH, or a program of teamai's own package. */
type RuntimeEntry = z.infer<typeof RuntimeMarkerSchema>['entry'];

/** How `definition`'s `entry` starts it, and what a person accepts first, or why it cannot: each form and layer takes one kind of entry. */
async function launchOf(definition: Definition, entry: RuntimeEntry): Promise<{ ok: true; launch: RuntimeLaunch; trust: RuntimeTrust } | { ok: false; reason: string }> {
  const isTeam = definition.layer === 'team';

  switch (entry.kind) {
    case 'path': {
      if (definition.form !== 'folder') return { ok: false, reason: `entry: ${entry.file} is a path, and a runtime file names an executable on PATH as entry: { command: <name> }; a runtime with its own code is a folder runtimes/<name>/${RUNTIME_MARKER}` };
      const relative = path.posix.normalize(entry.file.split(path.sep).join('/'));

      if (path.posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) return { ok: false, reason: `entry: ${entry.file} leaves the folder, and its entry is a file inside it, such as ./runtime` };
      const executable = path.join(definition.at, ...relative.split('/'));
      const stat = await fs.lstat(executable).catch(() => undefined);

      if (stat?.isFile() !== true) return { ok: false, reason: `entry: ${entry.file} names a file the folder does not hold` };

      return { ok: true, launch: { kind: 'executable', executable }, trust: isTeam ? { kind: 'folder', dir: definition.at } : { kind: 'none' } };
    }

    case 'bin': {
      if (definition.layer !== 'teamai') return { ok: false, reason: `entry: { bin: ${entry.bin} } names a program of teamai's own package, which only teamai's runtimes use; name an executable on PATH with entry: { command: <name> }, or keep the code in a folder runtimes/<name>/${RUNTIME_MARKER}` };
      const file = teamaiBin(entry.bin);

      return file === undefined ? { ok: false, reason: `entry: { bin: ${entry.bin} } names no program teamai's package holds` } : { ok: true, launch: { kind: 'node', file }, trust: { kind: 'none' } };
    }

    case 'command': {
      if (definition.form === 'folder') return { ok: false, reason: `entry: { command: ${entry.command} } is a command, and a runtime folder's entry is a file inside it, such as ./runtime` };

      if (definition.layer === 'teamai') return { ok: false, reason: `entry: { command: ${entry.command} } is a command on PATH, and teamai's runtimes run a program of its own package` };
      const executable = resolvePathCommand(entry.command);

      if (executable === null) return { ok: false, reason: `entry: { command: ${entry.command} } names no executable on PATH, as a bare name such as acme-runtime` };

      return { ok: true, launch: { kind: 'executable', executable }, trust: isTeam ? { kind: 'command', command: entry.command } : { kind: 'none' } };
    }

    default: {
      const unhandled: never = entry;

      return unhandled;
    }
  }
}

/** The member's own runtime named `name`, in ~/.teamai/runtimes/. */
async function fromPersonal(driver: ResolvedDriver, use: string, name: string): Promise<LayerLookup> {
  const found = await personalItem('runtimes', name, RUNTIME_MARKER);

  switch (found.kind) {
    case 'missing':
      return found;
    case 'duplicate':
      return { kind: 'refused', failure: { code: 'runtime_namespace_conflict', message: `Runtime "${name}" is defined twice in your own runtimes (${found.file} and ${found.folder}). Keep one, and start again.` } };
    case 'file':
    case 'folder':
      return readDefinition(driver, use, { layer: 'personal', resource: name, form: found.kind, at: found.kind === 'file' ? found.file : found.folder, location: found.kind === 'file' ? found.file : `${found.folder}${path.sep}` });
    default: {
      const unhandled: never = found;

      return unhandled;
    }
  }
}

/** The team's runtime named `name` in `driver`'s team tree, among the root and the active namespaces. */
async function fromTeam(driver: ResolvedDriver, use: string, name: string): Promise<LayerLookup> {
  const tree = teamTreeOf(driver.config);
  const base = getKnowledgeDir(driver.config);
  const refused = (message: string): LayerLookup => ({ kind: 'refused', failure: { code: 'runtime_not_found', message } });

  if (await isSymlink(path.join(base, RESOURCE_LAYOUTS.runtimes.dir))) {
    return refused(`Driver "${driver.name}" uses runtime "${use}", and runtimes in the team repo is a link, and teamai runs a team runtime only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.`);
  }

  const { resolutions, diagnostics } = await Resources.survey(RESOURCE_LAYOUTS.runtimes, { team: tree });
  // A folder that is a link holds code the team repo does not, so it is refused rather than passed over.
  const linked = diagnostics.find((diagnostic) => diagnostic.kind === 'invalid' && path.posix.basename(diagnostic.path) === name && diagnostic.path.endsWith('/'));

  if (linked) {
    const relative = linked.path.slice(0, -1);

    return refused(`Driver "${driver.name}" uses runtime "${use}", whose folder ${relative} in the team repo is a link, and teamai runs a team runtime only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.`);
  }

  const resolution = resolutions.find((candidate) => candidate.name === name);

  if (resolution === undefined) return { kind: 'missing' };

  if (resolution.kind === 'conflict') {
    const where = resolution.reason === 'duplicate' ? 'twice in one place' : 'in two active namespaces';

    return { kind: 'refused', failure: { code: 'runtime_namespace_conflict', message: `Runtime "${name}" is defined ${where} (${resolution.first.source.path} and ${resolution.second.source.path}). Keep one, push it, run teamai pull, and start again.` } };
  }

  const { source } = resolution.item;

  if (source.kind === 'folder') {
    const link = await firstLink(source.full);

    if (link !== undefined) {
      return refused(`Driver "${driver.name}" uses runtime "${use}", whose folder ${source.path.slice(0, -1)} in the team repo holds the link ${link}, and teamai runs a team runtime only when its folder holds no link, so the revision you accept is all it runs. Replace the link with what it names, push it, run teamai pull, and start again.`);
    }
  }

  return readDefinition(driver, use, { layer: 'team', resource: name, form: source.kind === 'folder' ? 'folder' : 'file', at: source.full, location: source.path });
}

/** teamai's own runtime named `name`, in `runtimes/` of its package. */
async function fromTeamai(driver: ResolvedDriver, use: string, name: string): Promise<LayerLookup> {
  const root = teamaiPackageDir();
  const resolution = await Resources.resolve(RESOURCE_LAYOUTS.runtimes, name, { teamai: { root, read: (file: ShippedFile) => file } });

  if (resolution.kind !== 'resolved' || resolution.item.layer !== 'teamai') return { kind: 'missing' };
  const { item } = resolution;

  return readDefinition(driver, use, {
    layer: 'teamai', resource: name, form: item.source.kind === 'folder' ? 'folder' : 'file', at: item.source.full, location: `teamai's ${item.shipped.relativePath}`, text: item.shipped.content,
  });
}

/** The runtime `use` names for `driver`, or why there is none. */
export async function locateRuntime(driver: ResolvedDriver, use: string): Promise<{ ok: true; source: RuntimeSource } | { ok: false; failure: WorkflowFailure }> {
  // `local` is the name `tools` had while it ran on the host beside the commands.
  if (use === 'tools' || use === 'local') return { ok: true, source: { kind: 'builtin', name: 'tools' } };

  if (use === 'skill') {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "${use}", which this version of teamai does not run from a definition. Use tools, or a runtime of your own or of the team.` } };
  }

  if (use === 'host') {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "host", the name teamai gives the command slot it adds to every definition. Name the runtime otherwise, or use tools.` } };
  }

  const names = use.startsWith(SHIPPED_PREFIX) ? [use] : [use, `${SHIPPED_PREFIX}${use}`];

  for (const name of names) {
    for (const layer of [fromPersonal, fromTeam, fromTeamai]) {
      const found = await layer(driver, use, name);

      switch (found.kind) {
        case 'found':
          return { ok: true, source: found.source };
        case 'refused':
          return { ok: false, failure: found.failure };
        case 'missing':
        case 'unusable':
          break;
        default: {
          const unhandled: never = found;

          return unhandled;
        }
      }
    }
  }

  const onPath = resolvePathCommand(`teamai-runtime-${use}`);

  if (onPath) return { ok: true, source: { kind: 'external', name: use, resource: `teamai-runtime-${use}`, layer: 'personal', marker: onPath, location: onPath, launch: { kind: 'executable', executable: onPath }, revision: '', trust: { kind: 'none' } } };

  return {
    ok: false,
    failure: {
      code: 'runtime_not_found',
      message: `Driver "${driver.name}" uses runtime "${use}", and none is installed: no ~/.teamai/runtimes/${use}.yaml or ${use}/${RUNTIME_MARKER}, none in the team repo's runtimes/, none that teamai ships, and no teamai-runtime-${use} on PATH.`,
    },
  };
}

/** The prefix of every runtime teamai ships, as of every default. */
const SHIPPED_PREFIX = 'teamai-';

/**
 * What a team runtime's folder holds, by relative path, sorted: its files, folders and links. A linked folder is not
 * walked, so nothing outside the folder is listed or read.
 */
async function runtimeEntries(dir: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [''];

  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const entry of await fs.readdir(path.join(dir, folder), { withFileTypes: true })) {
      const relative = path.join(folder, entry.name);
      found.push(relative);

      if (entry.isDirectory()) pending.push(relative);
    }
  }

  return found.sort();
}

/** The first link a team runtime's folder holds, by relative path, or none. */
async function firstLink(dir: string): Promise<string | undefined> {
  for (const relative of await runtimeEntries(dir).catch(() => [])) {
    if ((await fs.lstat(path.join(dir, relative)).catch(() => undefined))?.isSymbolicLink() === true) return relative.split(path.sep).join('/');
  }

  return undefined;
}

/**
 * A runtime folder's revision: a hash of every file under it, by relative path, executable bit and content, with a link
 * hashed as the path it names, never what it points to. Any change a teammate pushes there is a new revision.
 */
export async function runtimeRevision(dir: string): Promise<string> {
  const hash = createHash('sha256');

  for (const relative of await runtimeEntries(dir)) {
    const at = path.join(dir, relative);
    const stat = await fs.lstat(at);

    if (stat.isDirectory()) continue;
    const body = stat.isSymbolicLink() ? `link:${await fs.readlink(at)}` : await readRegularFileNoLink(at);
    hash.update(`${relative.split(path.sep).join('/')}\0${stat.mode & 0o111 ? 'x' : '-'}\0`).update(body).update('\0');
  }

  return hash.digest('hex');
}

const TrustFileSchema = z.object({ accepted: z.array(z.object({ dir: z.string(), revision: z.string(), acceptedAt: z.string() })) });

function trustFile(): string {
  return path.join(getTeamaiHomeDir(), 'trust', 'runtimes.json');
}

async function readTrust(): Promise<z.infer<typeof TrustFileSchema>> {
  try {
    return TrustFileSchema.parse(JSON.parse(await readRegularFile(trustFile(), 'utf8')));
  } catch {
    return { accepted: [] };
  }
}

/**
 * Asks the person at this terminal: true for yes, false for anything else, undefined when they closed the question
 * unanswered with Ctrl-C or Ctrl-D, which stops the command as it stops a step's question.
 */
export async function askAtTerminal(question: string): Promise<boolean | undefined> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return /^y(es)?$/i.test((await terminal.question(question)).trim());
  } catch {
    return undefined;
  } finally {
    terminal.close();
  }
}

/** Whether a runtime may run here, or why not. */
type Acceptance = { ok: true } | { ok: false; failure: WorkflowFailure };

function unanswered(source: ExternalRuntime): Acceptance {
  return { ok: false, failure: { code: 'interrupted', message: `The question to accept step runtime "${source.name}" closed without an answer, so it did not run and nothing was accepted. Run the same command again to answer it.` } };
}

/** Whether `source` was accepted here, asking no one: for a decision that must not wait on a person. */
export async function isRuntimeAccepted(source: ExternalRuntime): Promise<boolean> {
  return (await acceptRuntime(source, { mode: 'unattended', canAsk: false })).ok;
}

/**
 * Whether `source` may be spawned on this machine. Only a team runtime needs it: its folder's revision, or its file's
 * command at the file's content, must be one a person accepted here. `mode` attended with a person at the terminal
 * (`canAsk`) asks and records a yes; otherwise an unaccepted one is refused, naming what to run.
 */
export async function acceptRuntime(source: RuntimeSource, { mode, canAsk, ask = askAtTerminal }: { mode: RunMode; canAsk: boolean; ask?: (question: string) => Promise<boolean | undefined> }): Promise<Acceptance> {
  if (source.kind === 'builtin') return { ok: true };
  const { trust } = source;
  const isAsking = mode === 'attended' && canAsk;

  switch (trust.kind) {
    case 'none':
      return { ok: true };
    case 'command': {
      // The command's question takes the line typed; this one's `ask` answers yes or no, or nothing once closed.
      const askLine = async (question: string): Promise<string | undefined> => {
        const answer = await ask(question);

        return answer === undefined ? undefined : answer ? 'y' : 'n';
      };

      const accepted = await acceptTeamCommand(
        { kind: 'runtime', name: source.resource, command: trust.command, file: source.location, revision: source.revision },
        { ask: isAsking ? askLine : undefined },
      );

      if (accepted.ok) return accepted;

      return accepted.reason === 'unanswered' ? unanswered(source) : { ok: false, failure: { code: 'runtime_not_accepted', message: accepted.message } };
    }

    case 'folder':
      return acceptFolder(source, trust.dir, { isAsking, ask });
    default: {
      const unhandled: never = trust;

      return unhandled;
    }
  }
}

/** Whether the runtime folder `dir` of `source` was accepted here at its revision, asking when `isAsking`. */
async function acceptFolder(source: ExternalRuntime, dir: string, { isAsking, ask }: { isAsking: boolean; ask: (question: string) => Promise<boolean | undefined> }): Promise<Acceptance> {
  const revision = await runtimeRevision(dir);
  const trust = await readTrust();

  if (trust.accepted.some((entry) => entry.dir === dir && entry.revision === revision)) return { ok: true };
  const short = revision.slice(0, 12);
  const relative = source.location.replace(/\/$/, '');

  if (isAsking) {
    const question = `Step runtime "${source.name}" comes from the team repo (${relative}) at revision ${short}, which you have not accepted on this machine. `
      + `It runs as you, with your files. Review ${dir} (${(await runtimeEntries(dir)).join(', ')}) before you accept it.\nRun it? [y/N] `;

    const accepted = await ask(question);

    if (accepted === undefined) return unanswered(source);

    if (accepted) {
      await writeJsonAtomic(trustFile(), { accepted: [...trust.accepted, { dir, revision, acceptedAt: new Date().toISOString() }] });

      return { ok: true };
    }

    return { ok: false, failure: { code: 'runtime_not_accepted', message: `Step runtime "${source.name}" at revision ${short} was not accepted, so it did not run. Nothing of the run changed.` } };
  }

  return {
    ok: false,
    failure: {
      code: 'runtime_not_accepted',
      message: `Step runtime "${source.name}" comes from the team repo (${relative}) at revision ${short}, which no one has accepted on this machine, and an unattended run does not ask. `
        + 'Run the same command once in a terminal, attended, to review and accept that revision, then run it unattended again.',
    },
  };
}
