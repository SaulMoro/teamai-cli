/**
 * Runs a prompt with one directory as the tool's only readable root, through each adapter's `confined` profile: no team
 * env or secrets, no saved session, no hooks or MCP, and `TEAMAI_LAUNCHED_BY` set so the session is never captured.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { withoutTomlBom } from '../utils/toml.js';
import { observedEffort, observedModel, type ObservedEffort, type ObservedModel } from '../agent-observation.js';
import { LAUNCHED_BY_ENV, resolveRunMode, RUN_MODE_ENV } from '../launch-context.js';
import { opencodeMajorVersion } from '../opencode-version.js';
import { movedToolHome, realHost, toolHome } from '../tool-home.js';
import { isToolId, mcpSyntaxOf } from '../tool-registry.js';
import { parseJsonAs } from '../utils/json.js';
import { resolveCliPath } from '@teamai/shared/cli-path';
import { execCommand, probeBinary } from '@teamai/shared/exec';
import { agyGatewayEnv } from '../models/agy-gateway.js';
import { JsonValueSchema, type JsonValue } from '../types.js';
import type { ConfinedUsage } from '../tool-launch/confined-level.js';
import type { CallLaunch, ConfinedAccess, ConfinedLaunch, ConfinedLevel } from '@teamai/tool-core/launch';
import { extractReply } from '@teamai/tool-core/reply';
import type { HeadlessRun } from '@teamai/tool-launch/call-launch';
import { confinedArgs, confinedStdin, confinedVariables } from '@teamai/tool-launch/confined-launch';
import { runTool } from '@teamai/runtime-tools/headless';
import { stoppedOnUsageLimit, toolStdout, type TokenUsage } from '../tool-launch/stdout.js';
import { CONFINED_TOOLS, executableOf, launchAdapterIdOf, launchAdapterOf, type ConfinedTool } from '../tool-launch/tools.js';
import { readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';

/** A JSON line a tool prints; a field of the wrong type reads as absent. */
const RecordSchema = z.looseObject({
  type: z.unknown().optional(),
  result: z.string().optional().catch(undefined),
  structured_output: JsonValueSchema.optional().catch(undefined),
  total_cost_usd: z.number().optional().catch(undefined),
});

type ToolLookup = { resolveTool?: (tool: string) => string | null };

export function isConfinedTool(value: string): value is ConfinedTool {
  return CONFINED_TOOLS.some((tool) => tool === value);
}

/** The confined tools on this machine's PATH: `preferred` first, then the rest in launch-tool order. */
export function installedConfinedTools(preferred: readonly string[], { resolveTool = resolveCliPath }: ToolLookup = {}): ConfinedTool[] {
  const tools = new Set([...preferred, ...CONFINED_TOOLS].filter(isConfinedTool));

  return [...tools].filter((tool) => resolveTool(executableOf(tool)) !== null);
}

function profileOf(tool: ConfinedTool): ConfinedLaunch {
  return launchAdapterOf(tool).confined;
}

/**
 * The variables a confined run of `tool` gets: the common ones, proxies included, and those its profile reads, such as
 * its API key and gateway. Of a runtime's credentials, a confined prompt on it gets these. None for a tool with no
 * confined profile.
 */
export function confinedEnvNames(tool: string): readonly string[] {
  return isConfinedTool(tool) ? confinedVariables(profileOf(tool)) : [];
}

/** What `tool`, run confined, can do beyond answering, by its adapter's profile. */
export function confinedAccess(tool: ConfinedTool): ConfinedAccess {
  return profileOf(tool).access;
}

function profileIsolation(tool: ConfinedTool, version: string, isInsideCheckout: boolean): ConfinedLevel {
  return profileOf(tool).verified?.test(version) && !isInsideCheckout ? 'verified' : 'best-effort';
}

export interface ConfinedToolLevel {
  tool: ConfinedTool;
  version: string;
  isolation: ConfinedLevel;
}

/** The version of `tool` and the level its confined profile reaches on this machine; undefined when it is not on PATH. */
export async function confinedToolLevel(tool: ConfinedTool, { resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedToolLevel | undefined> {
  const executable = resolveTool(executableOf(tool));

  if (executable === null) return undefined;
  const tmp = await fs.realpath(os.tmpdir());
  const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env: confinedEnv(tool), cwd: tmp }));

  return { tool, version, isolation: profileIsolation(tool, version, launchAdapterIdOf(tool) === 'opencode' && await insideCheckout(tmp)) };
}

/** Each confined tool on PATH, its version, and the level its confined profile reaches on this machine. */
export async function confinedToolLevels({ resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedToolLevel[]> {
  const levels = await Promise.all(installedConfinedTools([], { resolveTool }).map((tool) => confinedToolLevel(tool, { resolveTool })));

  return levels.flatMap((level) => level ?? []);
}

/** Tools this machine runs confined at `level`, all with `access`, in launch-tool order. */
export interface ConfinedOffer {
  level: ConfinedLevel;
  access: ConfinedAccess;
  tools: [ConfinedTool, ...ConfinedTool[]];
}

/**
 * What this machine offers, strictest level first: the tools whose profile reaches `verified`, then every installed
 * tool at `best-effort`, each level split by what its tools can do. A tool is never offered at a level it cannot reach.
 */
export async function confinedOffers(lookup: ToolLookup = {}): Promise<ConfinedOffer[]> {
  const levels = await confinedToolLevels(lookup);
  const offers: ConfinedOffer[] = [];

  for (const level of ['verified', 'best-effort'] as const) {
    for (const { tool } of levels.filter((probed) => level === 'best-effort' || probed.isolation === 'verified')) {
      const access = confinedAccess(tool);
      const offer = offers.find((existing) => existing.level === level && existing.access === access);

      if (offer) offer.tools.push(tool);
      else offers.push({ level, access, tools: [tool] });
    }
  }

  return offers;
}

export interface ConfinedInput {
  tool: ConfinedTool;
  model?: { name: string; effort?: string };
  /** The tool's working directory and only readable root. Nothing is written into it. */
  dir: string;
  prompt: string;
  /** The JSON Schema the reply must follow, which tools that take one enforce. */
  schema?: JsonValue;
  /** The least level the run must reach; a tool that cannot reach it does not run. */
  level: ConfinedLevel;
  timeoutMs: number;
  /** The directory the tool's process group is recorded in, where `stopRecordedGroup` finds it if its caller dies. */
  group?: string;
  signal?: AbortSignal;
}

/** What ran: the tool, the model and effort observed, the level it reached, what it could do, and what it spent. */
export interface ConfinedRun {
  tool: ConfinedTool;
  model?: ObservedModel;
  effort?: ObservedEffort;
  isolation: ConfinedLevel;
  access: ConfinedAccess;
  usage?: ConfinedUsage;
}

export type ConfinedFailureCode = 'confined_tool_unavailable' | 'confined_failed' | 'confined_reply_invalid' | 'usage_limited';

export type ConfinedResult =
  | { ok: true; reply: JsonValue; run: ConfinedRun }
  /** `raw`: the tool's saved output. `reported`: the error the tool itself reported, when it reported one. */
  | { ok: false; code: ConfinedFailureCode; message: string; raw?: string; reported?: string; usage?: ConfinedUsage };

function memberEnv(): NodeJS.ProcessEnv {
  const restored = { ...process.env };

  for (const key of (restored.__TEAMAI_ENV_KEYS ?? '').split(' ').filter(Boolean)) {
    if (restored[`__TEAMAI_ENV_SET_${key}`] === '2') restored[key] = restored[`__TEAMAI_ENV_PREV_${key}`];
    else delete restored[key];
  }

  return restored;
}

function confinedEnv(tool: ConfinedTool): NodeJS.ProcessEnv {
  const restored = memberEnv();
  const { homeEnv: variable } = profileOf(tool);
  const moved = variable !== undefined && restored[variable] === undefined && isToolId(tool) ? movedToolHome(tool, realHost({ env: restored })) : null;

  const env: NodeJS.ProcessEnv = Object.fromEntries(confinedEnvNames(tool).flatMap((key) => restored[key] === undefined ? [] : [[key, restored[key]]]));

  if (variable !== undefined && moved !== null) env[variable] = moved;

  if (tool === 'agy') Object.assign(env, agyGatewayEnv(restored));
  env[LAUNCHED_BY_ENV] = 'confined';
  env[RUN_MODE_ENV] = resolveRunMode(process.env);

  return env;
}

async function optionalFile(file: string): Promise<string | undefined> {
  try { return await readRegularFile(file, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

async function claudeSettings(tool: ConfinedTool, env: NodeJS.ProcessEnv, tmp: string): Promise<string> {
  const file = path.join(env.CLAUDE_CONFIG_DIR || toolHome(tool), 'settings.json');
  const text = await optionalFile(file);
  const settings = text ? z.object({ env: z.record(z.string(), z.string()).optional(), model: z.string().optional() }).parse(JSON.parse(text)) : {};
  const allowed = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([key]) => profileOf(tool).env.includes(key)));
  const target = path.join(tmp, 'claude-settings.json');
  // An empty model stays undefined, which the JSON leaves out.
  await writeRegularFile(target, JSON.stringify({ env: allowed, model: settings.model || undefined }));

  return target;
}

function credentialEnv(key: string): string | undefined {
  if (['GH_TOKEN', 'GITHUB_TOKEN', 'GL_TOKEN', 'GITLAB_TOKEN', 'CI_JOB_TOKEN', 'BASH_ENV', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(key) || key.startsWith('__TEAMAI_ENV_')) {
    throw new Error(`The confined profile uses blocked credential variable ${key}. Use a dedicated provider API-key variable instead`);
  }

  return memberEnv()[key];
}

const CodexProviderSchema = z.object({ name: z.string().optional(), base_url: z.string().optional(), wire_api: z.string().optional(), env_key: z.string().optional(), experimental_bearer_token: z.string().optional() });

const CodexConfigSchema = z.object({ model: z.string().optional(), model_provider: z.string().optional(), model_providers: z.record(z.string(), CodexProviderSchema).optional() });

/** The overrides that keep the member's provider `name`, with its credential in a variable the confined env carries. */
function codexProviderArgs(name: string, provider: z.infer<typeof CodexProviderSchema>, env: NodeJS.ProcessEnv): string[] {
  const overrides: string[] = [];

  for (const key of ['name', 'base_url', 'wire_api'] as const) {
    if (provider[key]) overrides.push('-c', `model_providers.${name}.${key}=${JSON.stringify(provider[key])}`);
  }

  const credential = provider.experimental_bearer_token ?? (provider.env_key && credentialEnv(provider.env_key));

  if (credential) {
    env.TEAMAI_JUDGE_API_KEY = credential;
    overrides.push('-c', `model_providers.${name}.env_key="TEAMAI_JUDGE_API_KEY"`);
  }

  return overrides;
}

async function codexSettings(tool: ConfinedTool, env: NodeJS.ProcessEnv) {
  const text = await optionalFile(path.join(env.CODEX_HOME || toolHome(tool), 'config.toml'));

  if (!text) return { args: [], model: undefined };
  const config = CodexConfigSchema.parse(parseToml(withoutTomlBom(text)));
  const model = config.model ? ['-c', `model=${JSON.stringify(config.model)}`] : [];
  const name = config.model_provider;
  const provider = name ? config.model_providers?.[name] : undefined;

  if (!name || !provider) return { args: model, model: config.model };

  return { args: ['-c', `model_provider=${JSON.stringify(name)}`, ...model, ...codexProviderArgs(name, provider, env)], model: config.model };
}

const OpenCodeProviderSchema = z.object({ npm: z.enum(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic']).optional(), name: z.string().optional(), options: z.object({ baseURL: z.string().optional(), apiKey: z.string().optional() }).optional(), models: z.record(z.string(), z.object({ name: z.string().optional() })).optional() });

const OpenCodeConfigSchema = z.object({ model: z.string().optional(), provider: z.record(z.string(), OpenCodeProviderSchema.nullable()).optional() });

/** Replaces an `{env:KEY}` API key with that variable's value, which the confined env does not carry. */
function inlineEnvKey(options: { apiKey?: string } | undefined): void {
  const key = options?.apiKey?.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];

  if (options === undefined || key === undefined) return;
  const credential = credentialEnv(key);

  if (!credential) throw new Error(`OpenCode provider credential ${key} is not set`);
  options.apiKey = credential;
}

async function openCodeSettings(env: NodeJS.ProcessEnv, tmp: string): Promise<string | undefined> {
  const text = await optionalFile(process.env.OPENCODE_CONFIG || path.join(toolHome('opencode'), 'opencode.json'));
  const settings = text ? OpenCodeConfigSchema.parse(parseJsonAs(text, mcpSyntaxOf('opencode', 'user'))) : {};

  for (const entry of Object.values(settings.provider ?? {})) inlineEnvKey(entry?.options);

  const auth = await optionalFile(path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json'));

  for (const [key, dir] of [['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state'], ['XDG_CONFIG_HOME', 'xdg-config']] as const) {
    env[key] = path.join(tmp, dir);
    await fs.mkdir(path.join(tmp, dir), { recursive: true });
  }

  const data = path.join(tmp, 'data');
  await fs.mkdir(path.join(data, 'opencode'), { recursive: true });

  if (auth !== undefined) await writeRegularFile(path.join(data, 'opencode', 'auth.json'), auth, { mode: 0o600 });
  env.OPENCODE_DB = path.join(data, 'judge.db');
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.OPENCODE_DISABLE_CLAUDE_CODE = '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  const config = path.join(tmp, 'config');
  await fs.mkdir(config);
  await writeRegularFile(path.join(config, 'opencode.json'), JSON.stringify({ ...settings,
    permission: { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow', external_directory: 'deny', bash: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny', skill: 'deny' }, plugin: [], mcp: {},
  }), { mode: 0o600 });
  env.OPENCODE_CONFIG_DIR = config;

  return settings.model;
}

/** Codex's own permission profile: its sandboxed shell reads only `dir`, with no network, no writes and core env. */
function codexProfile(dir: string): string {
  return stringifyToml({
    default_permissions: 'judge',
    web_search: 'disabled',
    agents: { enabled: false },
    shell_environment_policy: { inherit: 'core' },
    permissions: { judge: { filesystem: { ':minimal': 'read', ':tmpdir': 'none', ':slash_tmp': 'none', [dir]: 'read' }, network: { enabled: false } } },
  });
}

function records(stdout: string): Array<z.infer<typeof RecordSchema>> {
  return stdout.split('\n').flatMap((line) => {
    try { const parsed = RecordSchema.safeParse(JSON.parse(line));

 return parsed.success ? [parsed.data] : []; }
    catch { return []; }
  });
}

/** Whether `dir` or a directory above it holds `.git` or `.hg`: OpenCode then lets its file tools read the whole checkout. */
async function insideCheckout(dir: string): Promise<boolean> {
  for (let at = dir;; at = path.dirname(at)) {
    for (const marker of ['.git', '.hg']) if (await fs.access(path.join(at, marker)).then(() => true, () => false)) return true;

    if (path.dirname(at) === at) return false;
  }
}

async function noInstructionsAbove(cwd: string): Promise<void> {
  for (let dir = cwd;; dir = path.dirname(dir)) {
    if (await optionalFile(path.join(dir, 'AGENTS.md')) !== undefined) throw new Error(`OpenCode would load instructions from ${path.join(dir, 'AGENTS.md')}`);

    if (path.dirname(dir) === dir) break;
  }
}

/** What a run spent, carried on its result when the tool reported any. */
interface Spend {
  usage?: ConfinedUsage;
}

function tokensOf(tool: ConfinedTool, stdout: string): TokenUsage | undefined {
  const reading = launchAdapterOf(tool).call.read({ stdout, lastMessage: undefined });

  return toolStdout(launchAdapterIdOf(tool), stdout)?.tokens ?? (reading.ok ? reading.tokens : undefined);
}

function spendOf(tool: ConfinedTool, stdout: string): Spend {
  const tokens = tokensOf(tool, stdout);
  const cost = records(stdout).findLast((record) => record.total_cost_usd !== undefined)?.total_cost_usd;

  if (!tokens && cost === undefined) return {};
  const usage: ConfinedUsage = {};

  if (tokens?.input !== undefined) usage.inputTokens = tokens.input;

  if (tokens?.output !== undefined) usage.outputTokens = tokens.output;

  if (cost !== undefined) usage.cost = { amount: cost, unit: 'USD' };

  return { usage };
}

type Family = ReturnType<typeof launchAdapterIdOf<ConfinedTool>>;

type ConfinedFailure = Extract<ConfinedResult, { ok: false }>;

/** What a family's launch is given: the run, where its tool runs, and the env and temporary directory it may set up. */
interface LaunchContext {
  input: ConfinedInput;
  executable: string;
  /** The real path of `input.dir`. */
  dir: string;
  cwd: string;
  tmp: string;
  env: NodeJS.ProcessEnv;
}

/** How a family runs: its arguments and stdin, the model its own config names, and a failure its run shows besides its exit code. */
interface Launch {
  args: string[];
  stdin: string;
  configuredModel?: string;
  failureOf?(run: HeadlessRun, spent: Spend): Promise<ConfinedFailure | undefined>;
}

const rawOf = (run: HeadlessRun): string => run.stdout + '\n' + run.stderr;

/** How each family is set up and started confined. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, as LAUNCH_ADAPTERS is; a tool picks one with TOOLS.launch
const LAUNCHES = {
  async claude(context) {
    const { input, env, tmp } = context;
    const settings = await claudeSettings(input.tool, env, tmp);
    const prompt = path.join(tmp, 'prompt.md');
    await writeRegularFile(prompt, input.prompt);

    return { stdin: confinedStdin('claude', input.prompt), args: confinedArgs({ family: 'claude', model: input.model, schema: input.schema, settingsFile: settings, promptFile: prompt }) };
  },
  async codex(context) {
    const { input, env, tmp, dir } = context;
    const settings = await codexSettings(input.tool, env);
    const auth = await optionalFile(path.join(env.CODEX_HOME || toolHome(input.tool), 'auth.json'));
    env.CODEX_HOME = path.join(tmp, 'codex');
    await fs.mkdir(env.CODEX_HOME);

    if (auth !== undefined) await writeRegularFile(path.join(env.CODEX_HOME, 'auth.json'), auth, { mode: 0o600 });
    await writeRegularFile(path.join(env.CODEX_HOME, 'config.toml'), codexProfile(dir));
    const schema = path.join(tmp, 'schema.json');

    if (input.schema !== undefined) await writeRegularFile(schema, JSON.stringify(input.schema));

    return {
      stdin: confinedStdin('codex', input.prompt),
      configuredModel: settings.model,
      args: confinedArgs({ family: 'codex', model: input.model, schemaFile: input.schema === undefined ? undefined : schema, answerFile: path.join(tmp, 'answer.json'), configArgs: settings.args }),
    };
  },
  async codebuddy({ input }) {
    return {
      stdin: confinedStdin('codebuddy', input.prompt),
      args: confinedArgs({ family: 'codebuddy', model: input.model, schema: input.schema }),
      // CodeBuddy exits 0 when it is not signed in.
      async failureOf(run) {
        if (!/Authentication required/.test(rawOf(run))) return undefined;

        return { ok: false, code: 'confined_tool_unavailable', message: 'CodeBuddy is not signed in. Sign in with codebuddy /login or set CODEBUDDY_API_KEY, then retry, or use another tool or driver.', raw: rawOf(run) };
      },
    };
  },
  async cursor({ input }) {
    return { stdin: confinedStdin('cursor', input.prompt), args: confinedArgs({ family: 'cursor', model: input.model }) };
  },
  async pi({ input }) {
    return { stdin: confinedStdin('pi', input.prompt), args: confinedArgs({ family: 'pi', model: input.model }) };
  },
  async agy({ input }) {
    return { stdin: confinedStdin('agy', input.prompt), args: confinedArgs({ family: 'agy', model: input.model }) };
  },
  async opencode(context) {
    const { input, executable, dir, cwd, env, tmp } = context;
    await fs.cp(dir, cwd, { recursive: true, dereference: false });
    const entries = await fs.readdir(cwd, { recursive: true, withFileTypes: true });

    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error(`OpenCode would follow a symlink in ${dir}. Remove the symlink before running it confined`);
    await noInstructionsAbove(cwd);

    return {
      stdin: confinedStdin('opencode', input.prompt),
      configuredModel: await openCodeSettings(env, tmp),
      args: confinedArgs({ family: 'opencode', model: input.model, opencodeMajor: input.model?.effort ? await opencodeMajorVersion(executable) : 2 }),
      // OpenCode keeps every run as a session in its database; the confined one must not outlive the run.
      async failureOf(run, spent) {
        const session = toolStdout('opencode', run.stdout)?.session;

        if (!session) return undefined;
        const deleted = await runTool({ executable, args: ['session', 'delete', session, '--standalone'], cwd, env, stdin: '', timeoutMs: input.timeoutMs, detached: true });

        if (deleted.code === 0) return undefined;

        return { ok: false, code: 'confined_failed', message: `OpenCode could not delete its session ${session}. Delete it with opencode session delete before retrying.`, raw: deleted.stderr, ...spent };
      },
    };
  },
} satisfies { [F in Family]: (context: LaunchContext) => Promise<Launch> };

/** Claude's result record, which CodeBuddy and Cursor print too; only Claude and CodeBuddy fill structured_output. */
async function resultRecordReply(stdout: string): Promise<JsonValue | undefined> {
  const last = records(stdout).findLast((record) => record.type === 'result');

  return last?.structured_output ?? extractReply(last?.result ?? '', JsonValueSchema);
}

async function adapterReply(tool: ConfinedTool, stdout: string): Promise<JsonValue | undefined> {
  const reading = launchAdapterOf(tool).call.read({ stdout, lastMessage: undefined });

  return reading.ok ? extractReply(reading.text, JsonValueSchema) : undefined;
}

const OpenCodeText = z.object({ type: z.literal('text'), part: z.object({ text: z.string() }) });

/** Where each family leaves its reply: Codex's answer file, a result record, OpenCode's text parts, or the adapter's reading. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, as LAUNCH_ADAPTERS is; a tool picks one with TOOLS.launch
const REPLIES = {
  codex: async (_stdout, tmp) => extractReply(await optionalFile(path.join(tmp, 'answer.json')) ?? '', JsonValueSchema),
  claude: resultRecordReply,
  codebuddy: resultRecordReply,
  cursor: resultRecordReply,
  opencode: async (stdout) => extractReply(records(stdout).flatMap((record) => {
    const parsed = OpenCodeText.safeParse(record);

    return parsed.success ? [parsed.data.part.text] : [];
  }).join('\n'), JsonValueSchema),
  pi: async (stdout, _tmp, tool) => adapterReply(tool, stdout),
  agy: async (stdout, _tmp, tool) => adapterReply(tool, stdout),
} satisfies { [F in Family]: (stdout: string, tmp: string, tool: ConfinedTool) => Promise<JsonValue | undefined> };

/** The level `context`'s tool reaches here, or why it does not reach `context.input.level`. */
async function levelReached({ input, executable, dir, cwd, env, tmp }: LaunchContext): Promise<{ ok: true; isolation: ConfinedLevel } | ConfinedFailure> {
  const version = await probeBinary(executable, ['--version'], (command, args, options) => execCommand(command, args, { ...options, env, cwd: tmp }));
  const checkout = launchAdapterIdOf(input.tool) === 'opencode' && await insideCheckout(cwd);
  const isolation = version ? profileIsolation(input.tool, version, checkout) : 'best-effort';

  if (input.level !== 'verified' || isolation === 'verified') return { ok: true, isolation };

  return { ok: false, code: 'confined_tool_unavailable', message: checkout
    ? `OpenCode would read ${dir} inside the checkout above ${cwd}, which it lets its file tools read. Move the temp dir (TMPDIR) outside any git or hg checkout, or use another driver.`
    : `${input.tool} ${version || '(version unknown)'} has no verified judge profile. Install a supported version or use another driver.` };
}

/** The error the tool reported, or '' when it reported none. */
function reportedError(tool: ConfinedTool, run: HeadlessRun): string {
  const family = launchAdapterIdOf(tool);
  const reading = launchAdapterOf(tool).call.read({ stdout: run.stdout, lastMessage: undefined });

  if (!reading.ok && reading.message) return reading.message;

  // agy exits 1 with the reason in its result, or on stderr when it refuses to start.
  return family === 'agy' && run.code !== 0 && !run.stdout.trim() ? run.stderr.trim() : '';
}

/** What ran, as far as the run showed it. A model or effort it did not observe stays undefined, which the JSON leaves out. */
function ranOn(input: ConfinedInput, launch: Launch, run: HeadlessRun, isolation: ConfinedLevel): ConfinedRun {
  const model = observedModel({ requested: input.model?.name ?? launch.configuredModel, reported: toolStdout(launchAdapterIdOf(input.tool), run.stdout)?.model });
  const effort = observedEffort({ requested: input.model?.effort });

  return { tool: input.tool, model: model || undefined, effort: effort || undefined, isolation, access: confinedAccess(input.tool) };
}

/** What a finished run gave: the error the tool reported, its exit code, or its reply. */
async function outcomeOf({ input, tmp }: LaunchContext, launch: Launch, run: HeadlessRun, isolation: ConfinedLevel): Promise<ConfinedResult> {
  const family = launchAdapterIdOf(input.tool);
  const raw = rawOf(run);
  const spent = spendOf(input.tool, run.stdout);
  const failure = await launch.failureOf?.(run, spent);

  if (failure) return failure;
  const reported = reportedError(input.tool, run);

  // A usage limit keeps its own code, which says the step can run again once the limit resets. A typed error decides by
  // its kind (OpenCode 2.x); one without a kind, by its text.
  const toolError: ConfinedFailure | undefined = !reported
    ? undefined
    : stoppedOnUsageLimit(toolStdout(family, run.stdout), reported)
      ? { ok: false, code: 'usage_limited', message: `${input.tool} hit its usage limit: ${reported}`, raw, reported, ...spent }
      : { ok: false, code: 'confined_failed', message: `${input.tool} reported an error: ${reported.replace(/\.?$/, '.')} Fix that, then retry or use another tool or driver.`, raw, reported, ...spent };

  if (run.code !== 0) return toolError ?? { ok: false, code: 'confined_failed', message: `${input.tool} exited with code ${run.code}${run.stopped === 'timeout' ? ` after its ${input.timeoutMs} ms limit` : ''}. See the saved output, then retry or use another tool or driver.`, raw, ...spent };
  const reply = await REPLIES[family](run.stdout, tmp, input.tool);

  // pi exits 0 on a provider error, which its reply carries.
  if (reply === undefined) return toolError ?? { ok: false, code: 'confined_reply_invalid', message: `${input.tool} did not reply with JSON. See the saved output, then retry.`, raw, ...spent };

  return { ok: true, reply, run: { ...ranOn(input, launch, run, isolation), ...spent } };
}

/**
 * Runs `input.prompt` on `input.tool` with `input.dir` as its working directory and only readable root, at least at
 * `input.level`, and returns its JSON reply with what ran. The prompt and the tool's own files go in a temporary
 * directory that is removed afterwards, never into `dir`, which may be evidence a hash covers.
 */
export async function runConfined(input: ConfinedInput, { resolveTool = resolveCliPath }: ToolLookup = {}): Promise<ConfinedResult> {
  const executable = resolveTool(executableOf(input.tool));

  if (!executable) return { ok: false, code: 'confined_tool_unavailable', message: `The ${input.tool} executable is not available on PATH. Install it, or use another tool or driver.` };
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-confined-')));

  try {
    const dir = await fs.realpath(input.dir);
    const family = launchAdapterIdOf(input.tool);
    // OpenCode reads a copy, so a checkout above the directory is checked where the copy goes.
    const context: LaunchContext = { input, executable, dir, cwd: family === 'opencode' ? path.join(tmp, 'dir') : dir, tmp, env: confinedEnv(input.tool) };
    const level = await levelReached(context);

    if (!level.ok) return level;
    const launch = await LAUNCHES[family](context);
    const { stdinOf }: CallLaunch = launchAdapterOf(input.tool).call;
    const run = await runTool({ executable, args: launch.args, cwd: context.cwd, env: context.env, stdin: stdinOf ? stdinOf(launch.stdin) : launch.stdin, timeoutMs: input.timeoutMs, detached: true, group: input.group, signal: input.signal });

    return await outcomeOf(context, launch, run, level.isolation);
  } catch (error) {
    return { ok: false, code: 'confined_failed', message: `${input.tool} could not run confined: ${error instanceof Error ? error.message : String(error)}. Fix that, then retry.` };
  } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}
