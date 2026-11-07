import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import type { RunMode } from '../../launch-context.js';
import { getKnowledgeDir, getTeamaiHomeDir, type LocalConfig } from '../../types.js';
import { resolveCliPath } from '../../utils/cli-path.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import type { DriverCan } from '../requirements.js';
import type { WorkflowFailure } from '../types.js';
import { shippedRuntimeFile } from '../../default-drivers.js';
import { personalDir, resolveDriver, teamItem, type ResolvedDriver } from './definitions.js';
import { localStepRuntime } from './local.js';
import { stdioStepRuntime } from './stdio.js';
import { SIGN_IN_VARIABLES, type InitInstance, type SignInVariables, type RuntimeFailure, type RuntimeOptions } from '@teamai/runtime-protocol';
import { acceptToolCommand, instanceHomeDir } from '../../tool-instances.js';
import { baseToolOf, instanceNames, toolOf } from '../../tool-registry.js';
import { credentialSecrets, type StepRuntime } from './step-runtime.js';
import { composedName, composedOffer, composedStepRuntime, nestedOptions } from './composed.js';
import { isExecRuntimeTool, type ExecRuntimeTool } from './attempt.js';
import { LOGIN_TOOLS, type LoginTool } from './login.js';

// ─── Where a step runtime comes from ─────────────────────
//
//  `local` is built in. Any other runtime is an external program, found first in the member's own
//  ~/.teamai/runtimes/<name>/, then in the team repo's runtimes/<name>/ (and runtimes/<namespace>/<name>/ for each
//  active namespace), then among the runtimes teamai ships (the `teamai-runtime-<name>` entries of its package's
//  `bin`, found in its own package directory), then as `teamai-runtime-<name>` on PATH. A runtime directory holds an executable named `runtime`.
//  A team runtime is code a teammate pushed, so before its first spawn at a revision a person accepts that revision:
//  an attended run asks, and an unattended one refuses.
//

/** The file in a runtime directory that teamai spawns. */
export const RUNTIME_ENTRY = 'runtime';

export type RuntimeSource =
  | { kind: 'builtin'; name: 'local' }
  | { kind: 'personal' | 'path'; name: string; executable: string }
  /** A runtime teamai ships, as a built file of its package that the Node running teamai runs. */
  | { kind: 'shipped'; name: string; file: string }
  | { kind: 'team'; name: string; executable: string; dir: string; relative: string };

async function isFile(at: string): Promise<boolean> {
  return (await fs.lstat(at).catch(() => undefined))?.isFile() === true;
}

/** The runtime `use` names for `driver`, or why there is none. */
export async function locateRuntime(driver: ResolvedDriver, use: string): Promise<{ ok: true; source: RuntimeSource } | { ok: false; failure: WorkflowFailure }> {
  if (use === 'local') return { ok: true, source: { kind: 'builtin', name: 'local' } };

  if (use === 'skill' || use === 'fleet') {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "${use}", which this version of teamai does not run from a definition. Use local, or a runtime of your own or of the team.` } };
  }

  if (use === 'host') {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "host", the name teamai gives the command slot it adds to every definition. Name the runtime otherwise, or use local.` } };
  }

  const personal = path.join(personalDir('runtimes'), use, RUNTIME_ENTRY);

  if (await isFile(personal)) return { ok: true, source: { kind: 'personal', name: use, executable: personal } };
  const root = path.join(getKnowledgeDir(driver.config), 'runtimes');
  const team = await teamItem(driver.config, root, use, '');

  if (team.kind === 'conflict') {
    return { ok: false, failure: { code: 'runtime_namespace_conflict', message: `Runtime "${use}" is defined in two active namespaces (${team.first} and ${team.second}). Keep it in one namespace, push it, run teamai pull, and start again.` } };
  }

  if (team.kind === 'found' && await isFile(path.join(team.at, RUNTIME_ENTRY))) {
    return { ok: true, source: { kind: 'team', name: use, executable: path.join(team.at, RUNTIME_ENTRY), dir: team.at, relative: path.relative(getKnowledgeDir(driver.config), team.at) } };
  }

  const shipped = shippedRuntimeFile(use);

  if (shipped) return { ok: true, source: { kind: 'shipped', name: use, file: shipped } };
  const onPath = resolveCliPath(`teamai-runtime-${use}`);

  if (onPath) return { ok: true, source: { kind: 'path', name: use, executable: onPath } };

  return {
    ok: false,
    failure: {
      code: 'runtime_not_found',
      message: `Driver "${driver.name}" uses runtime "${use}", and none is installed: no ~/.teamai/runtimes/${use}/${RUNTIME_ENTRY}, no runtimes/${use}/${RUNTIME_ENTRY} in the team repo, none that teamai ships, and no teamai-runtime-${use} on PATH.`,
    },
  };
}

/**
 * A team runtime's revision: a hash of every file under its directory, by relative path, executable bit and content,
 * with a link hashed as its target. Any change a teammate pushes there is a new revision.
 */
export async function runtimeRevision(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await fs.readdir(dir, { recursive: true })).sort();

  for (const relative of entries) {
    const at = path.join(dir, relative);
    const stat = await fs.lstat(at);

    if (stat.isDirectory()) continue;
    const body = stat.isSymbolicLink() ? `link:${await fs.readlink(at)}` : await fs.readFile(at);
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
    return TrustFileSchema.parse(JSON.parse(await fs.readFile(trustFile(), 'utf8')));
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

/**
 * Whether `source` may be spawned on this machine. Only a team runtime needs it: its revision must be one a person
 * accepted here. `mode` attended with a person at the terminal (`canAsk`) asks and records a yes; otherwise an
 * unaccepted revision is refused, naming what to run.
 */
export async function acceptRuntime(source: RuntimeSource, { mode, canAsk, ask = askAtTerminal }: { mode: RunMode; canAsk: boolean; ask?: (question: string) => Promise<boolean | undefined> }): Promise<{ ok: true } | { ok: false; failure: WorkflowFailure }> {
  if (source.kind !== 'team') return { ok: true };
  const revision = await runtimeRevision(source.dir);
  const trust = await readTrust();

  if (trust.accepted.some((entry) => entry.dir === source.dir && entry.revision === revision)) return { ok: true };
  const short = revision.slice(0, 12);
  const files = (await fs.readdir(source.dir, { recursive: true })).sort();

  if (mode === 'attended' && canAsk) {
    const question = `Step runtime "${source.name}" comes from the team repo (${source.relative}) at revision ${short}, which you have not accepted on this machine. `
      + `It runs as you, with your files. Review ${source.dir} (${files.join(', ')}) before you accept it.\nRun it? [y/N] `;

    const accepted = await ask(question);

    if (accepted === undefined) {
      return { ok: false, failure: { code: 'interrupted', message: `The question to accept step runtime "${source.name}" closed without an answer, so it did not run and nothing was accepted. Run the same command again to answer it.` } };
    }

    if (accepted) {
      await writeJsonAtomic(trustFile(), { accepted: [...trust.accepted, { dir: source.dir, revision, acceptedAt: new Date().toISOString() }] });

      return { ok: true };
    }

    return { ok: false, failure: { code: 'runtime_not_accepted', message: `Step runtime "${source.name}" at revision ${short} was not accepted, so it did not run. Nothing of the run changed.` } };
  }

  return {
    ok: false,
    failure: {
      code: 'runtime_not_accepted',
      message: `Step runtime "${source.name}" comes from the team repo (${source.relative}) at revision ${short}, which no one has accepted on this machine, and an unattended run does not ask. `
        + 'Run the same command once in a terminal, attended, to review and accept that revision, then run it unattended again.',
    },
  };
}

/** An environment variable's name, as a credential's name and the variable it is read from are written. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a credential's value is given: `env:<VARIABLE>`, read from the member's environment at start. */
const FROM_ENV = z.templateLiteral(['env:', z.string().regex(ENV_NAME)]);

const CREDENTIALS_TAKE = `credentials take ${LOGIN_TOOLS.map((known) => `${known}: login`).join(', ')}, the login teamai keeps for that tool, or NAME: env:VARIABLE, a value read from your environment`;

/** One credential entry: a login teamai keeps for a tool, or a value the member's environment gives under a name. */
const CredentialSchema = z.union([
  z.tuple([z.enum(LOGIN_TOOLS), z.literal('login')]).transform(([tool]) => ({ kind: 'login' as const, tool })),
  z.tuple([z.string().regex(ENV_NAME), FROM_ENV]).transform(([name, from]) => ({ kind: 'env' as const, name, variable: from.slice('env:'.length) })),
]);

/**
 * What teamai itself reads of a runtime entry's options; every other key goes to the runtime at `init`, which
 * validates it. `max_parallel` caps the runtime's own open attempts; `credentials` names the logins and the values it brings.
 */
const EngineOptionsSchema = z.object({
  max_parallel: z.number().int().min(1, 'max_parallel is a whole number of attempts, 1 or more').optional(),
  credentials: z.record(z.string(), z.string()).optional(),
});

export interface EngineOptions {
  maxParallel?: number;
  logins: LoginTool[];
}

/** A credential a runtime entry declares from the member's environment: the name its processes get, and the variable it is read from. */
export interface EnvCredential {
  name: string;
  variable: string;
}

/**
 * Splits `options` into what teamai reads and what the runtime gets, or names the first key teamai refuses. Engine
 * keys never reach the runtime: they are stripped before `init`.
 */
export function engineOptions(options: RuntimeOptions): { ok: true; engine: EngineOptions; credentials: EnvCredential[]; runtime: RuntimeOptions } | { ok: false; key: string; message: string } {
  const parsed = EngineOptionsSchema.safeParse(options);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const key = issue?.path.join('.') || 'credentials';

    return { ok: false, key, message: key.startsWith('credentials') ? CREDENTIALS_TAKE : issue?.message ?? 'not valid' };
  }

  const { max_parallel: maxParallel, credentials, ...runtime } = { ...options, ...parsed.data };
  const entries: Array<z.output<typeof CredentialSchema>> = [];

  for (const entry of Object.entries(credentials ?? {})) {
    const credential = CredentialSchema.safeParse(entry);

    if (!credential.success) return { ok: false, key: `credentials.${entry[0]}`, message: CREDENTIALS_TAKE };
    entries.push(credential.data);
  }

  const engine: EngineOptions = { logins: entries.flatMap((entry) => (entry.kind === 'login' ? [entry.tool] : [])) };

  if (maxParallel !== undefined) engine.maxParallel = maxParallel;

  return { ok: true, engine, credentials: entries.flatMap((entry) => (entry.kind === 'env' ? [{ name: entry.name, variable: entry.variable }] : [])), runtime };
}

/**
 * The values of `credentials`, read from `env` once, at start, and held in memory only: never written to a record, a
 * log or runtime.json. Fails naming the first variable that is unset.
 */
function credentialValues(driver: ResolvedDriver, use: string, credentials: EnvCredential[], env: NodeJS.ProcessEnv): { ok: true; values: Record<string, string> } | { ok: false; failure: WorkflowFailure } {
  const values: Record<string, string> = {};

  for (const { name, variable } of credentials) {
    const value = env[variable];

    if (value === undefined || value === '') {
      return {
        ok: false,
        failure: { code: 'credential_missing', message: `Runtime "${use}" of driver definition ${driver.file} declares credential ${name}: env:${variable}, and ${variable} is not set in your environment. Set ${variable}, then start again.` },
      };
    }

    values[name] = value;
  }

  return { ok: true, values };
}

/** The values of `credentials` that `env` sets, by name, skipping those it does not: for masking only. */
function valuesSet(credentials: EnvCredential[], env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(credentials.flatMap(({ name, variable }) => (env[variable] ? [[name, env[variable]]] : [])));
}

/** The sign-in variables of each tool an exec runtime launches: the protocol must name every one. */
const SIGN_INS: Readonly<Record<ExecRuntimeTool, SignInVariables>> = SIGN_IN_VARIABLES;

/** A tool's sign-in variables and those that go with them. */
function variablesOf({ signIn, alongside = [] }: SignInVariables): string[] {
  return [...signIn, ...alongside];
}

/**
 * `credentials` as the process of `tool` gets them: a sign-in variable teamai found by name (`found`) goes only to the
 * tool it signs in, so a Claude exec never gets the member's OpenAI key. Declared credentials go to every tool.
 */
export function credentialsForTool(credentials: Record<string, string>, found: readonly string[], tool: string): Record<string, string> {
  // An instance signs in as the tool it extends.
  const base = baseToolOf(tool);
  const own = new Set(isExecRuntimeTool(base) ? variablesOf(SIGN_INS[base]) : []);

  return Object.fromEntries(Object.entries(credentials).filter(([name]) => !found.includes(name) || own.has(name)));
}

/** The values of the tools' sign-in variables set in `env`, by name, with those that go with a sign-in found. */
function signInsFound(env: NodeJS.ProcessEnv): Record<string, string> {
  const isSet = (name: string): boolean => (env[name] ?? '') !== '';
  const names = Object.values(SIGN_INS).flatMap((variables) => (variables.signIn.some(isSet) ? variablesOf(variables) : []));

  return Object.fromEntries(names.filter(isSet).sort().map((name) => [name, env[name] ?? '']));
}

/** One runtime of an opened definition: `local` in teamai's process, or an external one that took its options. */
export type OpenedRuntime =
  | { kind: 'local'; use: 'local'; engine: EngineOptions }
  /**
   * `launchesAgents`: prompt steps reach it as `prompt`, and it gives each tool its own home. `credentials`: the values
   * of the credentials it declares from the member's environment, by name, in memory only. `masks`: the values its
   * notices are masked with, by label: those credentials', and each team secret the drive adds once it resolves it.
   * `found`: the names among `credentials` teamai found in the member's environment rather than the definition declared,
   * which go only to the tool each signs in (`credentialsForTool`). `unavailable`: the tools it cannot run now, with why.
   * `optionsFrom`: where its options were set, for the person: the definition's file, and the member's config when it sets them too.
   */
  | { kind: 'external'; use: string; runtime: StepRuntime; can: DriverCan; launchesAgents: boolean; engine: EngineOptions; credentials: Record<string, string>; found: string[]; masks: Record<string, string>; optionsFrom: string; unavailable?: Record<string, string> };

/** A driver definition ready to drive: each of its runtimes, in definition order. The caller disposes them once the drive ends. */
export interface OpenedDriver {
  driver: ResolvedDriver;
  runtimes: [OpenedRuntime, ...OpenedRuntime[]];
}

/** Ends the connection to each external runtime of `opened`. */
export async function disposeDriver(opened: OpenedDriver): Promise<void> {
  await Promise.all(opened.runtimes.map((entry) => (entry.kind === 'external' ? entry.runtime.dispose() : undefined)));
}

/**
 * The options the definition gives runtime `use`, with the member's `workflows.drivers.<driver>.runtimes.<use>` from
 * user and workspace config over them, key by key.
 */
function entryOptions(driver: ResolvedDriver, use: string, given: RuntimeOptions | undefined): RuntimeOptions {
  return { ...given, ...driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use] };
}

/** Where runtime `use` of `driver` got its options: the definition's file, and the member's config when it sets them too. */
function optionsSource(driver: ResolvedDriver, use: string): string {
  return driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use] === undefined ? driver.file : `${driver.file} or your workflows.drivers.${driver.name}.runtimes.${use}`;
}

function badOption(driver: ResolvedDriver, use: string, key: string, message: string): WorkflowFailure {
  return { code: 'bad_option', message: `Runtime "${use}" of driver definition ${driver.file} refused option "${key}": ${message}. Fix the option and start again.` };
}

/**
 * Why a definition is opened: `run` runs steps, so the values of its `env:` credentials are read and fail it when unset;
 * `stop` only stops and closes attempts, which bring no credential, so a cancel works in a shell without them. A runtime
 * opened to stop is opened in `recover` mode, which runs no sign-in or tool check and answers only for the handles it
 * recorded, so a provider that is down or stalls cannot hold the stop; only one that refuses that mode is opened for new
 * work instead. `check` only asks whether a run could start on it now: each runtime gets `init` as for an `unattended`
 * run, marked `checkOnly`, and nothing more, a credential variable left unset fails it as it would the run, and a team
 * runtime no one accepted here is not asked about.
 */
export type DriverPurpose = 'run' | 'stop' | 'check';

/**
 * The tool instances the member may run, as `init` gives them: their own, and the team's whose command needs no
 * acceptance or was accepted on this machine. A runtime lists in `can.tools` the ones it can serve.
 */
async function runnableInstances(): Promise<InitInstance[]> {
  const instances = instanceNames().flatMap((name) => toolOf(name)?.instance ?? []);
  const accepted = await Promise.all(instances.map(async (instance) => (await acceptToolCommand(instance, { ask: undefined })).ok));

  return instances.filter((_, index) => accepted[index]).map((instance) => ({
    name: instance.name, tool: instance.extends,
    ...(instance.command !== undefined && { command: instance.command }),
    // Resolved once, here, and absolute, a relative value from where teamai runs: a runtime uses this home and never resolves one of its own.
    ...(instance.home && { home: { dir: path.resolve(instanceHomeDir(instance.home, instance.extends)), ...(instance.home.env !== undefined && { env: instance.home.env }) } }),
    ...(instance.paths && { paths: instance.paths }),
  }));
}

/** Opens one runtime of `driver`: finds it, refuses a team runtime no one accepted here, starts it and passes its options. */
async function openRuntime(driver: ResolvedDriver, use: string, options: RuntimeOptions, { mode, canAsk, purpose, checkout }: { mode: RunMode; canAsk: boolean; purpose: DriverPurpose; checkout: string }): Promise<{ ok: true; opened: OpenedRuntime } | { ok: false; failure: WorkflowFailure }> {
  const split = engineOptions(options);

  if (!split.ok) return { ok: false, failure: badOption(driver, use, split.key, split.message) };
  const located = await locateRuntime(driver, use);

  if (!located.ok) return located;
  const { source } = located;

  if (source.kind === 'builtin') {
    const checked = await localStepRuntime().init({ options: split.runtime, mode });

    if (!checked.ok) return { ok: false, failure: badOption(driver, use, checked.failure.key ?? '?', checked.failure.message) };

    if (split.engine.logins.length > 0) return { ok: false, failure: badOption(driver, use, 'credentials', 'local runs each tool in the member\'s own home, so it brings no login') };

    if (split.credentials.length > 0) return { ok: false, failure: badOption(driver, use, 'credentials', 'local runs each step in the member\'s own environment, so it brings no credential') };

    return { ok: true, opened: { kind: 'local', use: 'local', engine: split.engine } };
  }

  // A check fails as the run would for an unset variable, and sends no value.
  const values = purpose === 'stop' ? { ok: true as const, values: {} } : credentialValues(driver, use, split.credentials, process.env);

  if (!values.ok) return values;
  const accepted = await acceptRuntime(source, purpose === 'check' ? { mode: 'unattended', canAsk: false } : { mode, canAsk });

  if (!accepted.ok) return accepted;
  const isDeclaring = split.credentials.length > 0 || split.engine.logins.length > 0;
  const found = purpose === 'run' && !isDeclaring ? signInsFound(process.env) : {};

  // What the runtime tells the person is shown with the values of the credentials it gets masked, and with the team's
  // secrets, which the drive adds here as it resolves them (`masks`). A stop sends no credential, but still masks with
  // the values the member's environment holds for them, which what the attempt left may echo.
  const masks = credentialSecrets(source.name, { ...values.values, ...found, ...(purpose === 'stop' && valuesSet(split.credentials, process.env)) });

  const spawned = (): StepRuntime => (source.kind === 'shipped'
    ? stdioStepRuntime({ name: source.name, command: process.execPath, args: [source.file], cwd: checkout, secrets: masks })
    : stdioStepRuntime({ name: source.name, command: source.executable, cwd: checkout, secrets: masks }));

  let notRecovered: RuntimeFailure | undefined;

  if (purpose === 'stop') {
    const recovering = spawned();
    const recovered = await recovering.init({ options: split.runtime, mode: 'recover', checkout });

    // It offers nothing in this mode: it is asked only to stop, collect and close what it ran.
    if (recovered.ok) return { ok: true, opened: { kind: 'external', use, runtime: recovering, can: recovered.can, launchesAgents: recovered.launchesAgents, engine: split.engine, credentials: {}, found: [], masks, optionsFrom: optionsSource(driver, use) } };
    await recovering.dispose();
    notRecovered = recovered.failure;
  }

  const runtime = spawned();
  const credentials = { env: [...split.credentials.map((credential) => credential.name), ...Object.keys(found)], logins: split.engine.logins };

  const ready = await runtime.init({
    options: split.runtime, mode: purpose === 'check' ? 'unattended' : mode, credentials, instances: await runnableInstances(), checkout, ...(purpose === 'check' && { checkOnly: true as const }),
  });

  if (ready.ok && ready.launchesAgents && split.engine.logins.length > 0) {
    await runtime.dispose();

    return { ok: false, failure: badOption(driver, use, 'credentials', `${use} launches agents its own way, in each tool's own home, so it brings no login`) };
  }

  // A credential is a value of the environment: only a runtime that controls its processes' environment keeps it to them.
  if (ready.ok && split.credentials.length > 0 && ready.can.env !== true) {
    await runtime.dispose();

    return { ok: false, failure: badOption(driver, use, 'credentials', `${use} does not offer can.env, so it cannot keep a credential to the processes it is for`) };
  }

  if (ready.ok && !ready.launchesAgents && ready.can.exec === false) {
    await runtime.dispose();

    return {
      ok: false,
      failure: { code: 'runtime_failed', message: `Runtime "${source.name}" of driver "${driver.name}" runs no command and takes no prompt (its init offers can.exec: false without prompt: true), so it can run no step. Fix the runtime's offer, or remove it from the definition.` },
    };
  }

  if (ready.ok) {
    // A runtime may name an instance in ownLogins: its login is the tool's it extends, as its sign-in is.
    const ownLogins = new Set((ready.ownLogins ?? []).map(baseToolOf));
    // A login the runtime's provider keeps itself is not copied into an attempt's tool home over it.
    const engine = { ...split.engine, logins: split.engine.logins.filter((tool) => !ownLogins.has(tool)) };

    // A sign-in found by name reaches only a runtime that execs the tool and keeps a value to it. One that launches
    // agents its own way signs them in where it runs them, so it gets none, rather than the start failing over it.
    const isKeepingFound = !ready.launchesAgents && ready.can.env === true;
    // A tool whose login the runtime's provider keeps signs in on that login, before the member's own route: the
    // credentials their config declares, then what their environment holds. The definition's own credential still goes.
    const ownLoginVariables = new Set(Object.entries(SIGN_INS).flatMap(([tool, variables]) => (ownLogins.has(tool) ? variablesOf(variables) : [])));
    const notOwnLogin = (given: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(given).filter(([name]) => !ownLoginVariables.has(name)));
    const foundHere = notOwnLogin(found);
    const isMemberRoute = driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use]?.credentials !== undefined;
    const declared = isMemberRoute ? notOwnLogin(values.values) : values.values;
    const given = isKeepingFound ? { ...declared, ...foundHere } : declared;

    return { ok: true, opened: { kind: 'external', use, runtime, can: ready.can, launchesAgents: ready.launchesAgents, engine, credentials: given, found: isKeepingFound ? Object.keys(foundHere) : [], masks, optionsFrom: optionsSource(driver, use), ...(ready.unavailable && { unavailable: ready.unavailable }) } };
  }

  await runtime.dispose();
  const { failure } = ready;

  const notStarted = failure.code === 'bad_option'
    ? badOption(driver, use, failure.key ?? '?', failure.message)
    : { code: 'runtime_failed', message: `Runtime "${source.name}" of driver "${driver.name}" did not start (${failure.code}): ${failure.message}` };

  if (notRecovered === undefined) return { ok: false, failure: notStarted };

  return { ok: false, failure: { code: notStarted.code, message: `${notStarted.message} It does not open in recover mode either, to stop what it ran (${notRecovered.code}): ${notRecovered.message}` } };
}

/**
 * Opens runtime `names.inner` through `names.outer`, each with the options `options` nests under its name, as one
 * runtime: each is found, accepted and started as a runtime of its own, then the engine reaches both through
 * `composedStepRuntime` with the offer `composedOffer` merges. The prompt's credentials are the outer's, which runs the
 * tool; the inner keeps its own.
 */
async function openComposed(driver: ResolvedDriver, names: { inner: string; outer: string }, options: RuntimeOptions, how: Parameters<typeof openRuntime>[3]): Promise<{ ok: true; opened: OpenedRuntime } | { ok: false; failure: WorkflowFailure }> {
  const name = composedName(names.inner, names.outer);
  const nested = nestedOptions(options, names);

  if (!nested.ok) return { ok: false, failure: badOption(driver, name, nested.key, nested.message) };
  const outer = await openRuntime(driver, names.outer, entryOptions(driver, names.outer, nested.outer), how);

  if (!outer.ok) return outer;
  const inner = await openRuntime(driver, names.inner, entryOptions(driver, names.inner, nested.inner), how);

  if (!inner.ok) {
    if (outer.opened.kind === 'external') await outer.opened.runtime.dispose();

    return inner;
  }

  if (outer.opened.kind !== 'external' || inner.opened.kind !== 'external') {
    await Promise.all([outer.opened, inner.opened].map((part) => (part.kind === 'external' ? part.runtime.dispose() : undefined)));

    return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.file} runs ${names.inner} through ${names.outer}, and local runs in teamai's own process: it runs neither through another runtime nor another through it. Fix the file and start again.` } };
  }

  const [outerOpened, innerOpened] = [outer.opened, inner.opened];

  // Only a runtime that launches agents its own way has tools to run through another; one that execs them would run
  // nothing on the inner side, and its steps would run on the outer alone.
  if (!innerOpened.launchesAgents) {
    await Promise.all([outerOpened.runtime.dispose(), innerOpened.runtime.dispose()]);

    return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.file} runs ${names.inner} through ${names.outer}, and ${names.inner} launches no agents of its own: only a runtime that launches agents, such as an app's, runs its tools through another. Use ${names.outer} on its own, or fix the file, and start again.` } };
  }

  const offer = composedOffer({ ok: true, can: outerOpened.can, launchesAgents: outerOpened.launchesAgents }, { ok: true, can: innerOpened.can, launchesAgents: innerOpened.launchesAgents, ...(innerOpened.unavailable && { unavailable: innerOpened.unavailable }) });
  const caps = [outerOpened.engine.maxParallel, innerOpened.engine.maxParallel].filter((cap) => cap !== undefined);
  const engine: EngineOptions = { ...outerOpened.engine, ...(caps.length > 0 && { maxParallel: Math.min(...caps) }) };

  return {
    ok: true,
    opened: {
      kind: 'external', use: name, runtime: composedStepRuntime({ outer: outerOpened.runtime, inner: innerOpened.runtime, innerCredentials: innerOpened.credentials }),
      can: offer.can, launchesAgents: offer.launchesAgents, engine, credentials: outerOpened.credentials, found: outerOpened.found, masks: { ...outerOpened.masks, ...innerOpened.masks }, optionsFrom: innerOpened.optionsFrom,
      ...(offer.unavailable && { unavailable: offer.unavailable }),
    },
  };
}

/**
 * Opens the definition `--driver <name>` names in `config`: resolves it (`personal: false` skips the member's own),
 * then opens each of its runtimes in order, so a bad option of any fails before a step runs. Each starts in `checkout`,
 * the run's, which its `init` names too.
 */
export async function openDriver(config: LocalConfig, name: string, { personal, mode, canAsk, purpose, checkout }: { personal: boolean; mode: RunMode; canAsk: boolean; purpose: DriverPurpose; checkout: string }): Promise<{ ok: true; opened: OpenedDriver } | { ok: false; failure: WorkflowFailure }> {
  const resolved = await resolveDriver(config, name, { personal });

  if (!resolved.ok) return resolved;
  const { driver } = resolved;
  const opened: OpenedRuntime[] = [];
  const how = { mode, canAsk, purpose, checkout };

  for (const entry of driver.definition.runtimes) {
    const one = entry.through === undefined
      ? await openRuntime(driver, entry.use, entryOptions(driver, entry.use, entry.options), how)
      : await openComposed(driver, { inner: entry.use, outer: entry.through }, entry.options ?? {}, how);

    if (!one.ok) {
      await Promise.all(opened.map((done) => (done.kind === 'external' ? done.runtime.dispose() : undefined)));

      return one;
    }

    opened.push(one.opened);
  }

  const [first, ...rest] = opened;

  if (!first) return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.file} lists no runtime. Add one under runtimes and start again.` } };

  return { ok: true, opened: { driver, runtimes: [first, ...rest] } };
}

/**
 * Whether a run could start now, from `checkout`, on the definition `--driver <name>` names in `config`, the member's
 * own first, or why not: each of its runtimes opens as for an unattended run, so none asks for a sign-in, and is closed
 * at once.
 */
export async function checkDriver(config: LocalConfig, name: string, checkout: string): Promise<{ ok: true } | { ok: false; failure: WorkflowFailure }> {
  const opened = await openDriver(config, name, { personal: true, mode: 'attended', canAsk: false, purpose: 'check', checkout });

  if (!opened.ok) return opened;
  await disposeDriver(opened.opened);

  return { ok: true };
}
