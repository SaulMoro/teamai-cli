import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OpIdSchema, type PromptLeaseSchema, type PromptRequestSchema, type RuntimeMessage, type RuntimeMode, type RuntimeOptions } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { isCodexExecutable } from './daemon.js';
import { agentIdOf } from './runtime.js';
import { paseoApp } from './testing/asar.js';
import { startFakeDaemon, type Behaviour } from './testing/fake-daemon.js';
import { startRuntime, TEST_CLIENT, type Runtime } from './testing/harness.js';

/**
 * teamai-runtime-paseo through its stdio entry, as teamai spawns it, against a fake Paseo daemon that speaks Paseo
 * 0.14.0's WebSocket protocol and checks every frame against Paseo's own schemas.
 */

let dir: string;
let worktree: string;
let daemonState: string;
let daemon: Awaited<ReturnType<typeof startFakeDaemon>>;
const runtimes: Runtime[] = [];

const RUN = 'r0123abcd';
const ATTEMPT = 'a0123abcd';

const behave = (behaviour: Behaviour): void => fs.writeFileSync(path.join(daemonState, 'behaviour.json'), JSON.stringify(behaviour));

/** The agent creates and cancels, and the workspace archives, the daemon received, as they crossed the wire. */
const received = (): Array<Record<string, unknown> & { type: string }> => {
  const file = path.join(daemonState, 'requests.jsonl');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

/** The agents a cancel or an archive stopped, as they stopped running. */
const stopped = (): unknown[] => {
  const file = path.join(daemonState, 'stopped.jsonl');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

const start = (env?: Record<string, string | undefined>): Runtime => {
  const runtime = startRuntime(path.join(dir, 'home'), env);
  runtimes.push(runtime);

  return runtime;
};

const isOp = (op: string, event: string) => (line: RuntimeMessage): boolean => 'op' in line && line.op === op && 'event' in line && line.event === event;
const isEnd = (op: string) => (line: RuntimeMessage): boolean => 'op' in line && line.op === op && 'event' in line && ['finished', 'failed', 'cancelled'].includes(line.event);
const isInit = (line: RuntimeMessage): boolean => 'type' in line && line.type === 'init';

async function ready(runtime: Runtime, { mode = 'unattended', options = { url: daemon.url } }: { mode?: RuntimeMode; options?: RuntimeOptions } = {}): Promise<RuntimeMessage> {
  runtime.send({ type: 'init', protocol: 1, mode, options });

  return runtime.next(isInit);
}

const openRequest = (op: string, attempt: string) => ({
  type: 'open' as const, op, run: RUN, attempt, credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} },
});

/** Opens the attempt's place and waits until it is ready, as teamai does before it sends a prompt there. */
async function opened(runtime: Runtime, { attempt = ATTEMPT, op = 'op-0000000a' } = {}): Promise<string> {
  runtime.send(openRequest(op, attempt));
  const accepted = await runtime.next(isOp(op, 'accepted'));

  if (!('handle' in accepted) || !accepted.handle) throw new Error(`no handle in ${JSON.stringify(accepted)}`);
  await runtime.next((line) => isOp(op, 'ready')(line) || isOp(op, 'failed')(line));

  return accepted.handle;
}

/** Every file the runtime's journal holds, by its path under the journal. */
const journalFiles = (): string[] => {
  const root = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo');

  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))) : [];
};

/** The agents the fake daemon holds, by id. */
const agentsOf = (): string[] => {
  const file = path.join(daemonState, 'agents.json');

  return fs.existsSync(file) ? Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { agents: Record<string, unknown> }).agents) : [];
};

/** How a close that keeps an attempt, while a create it sent may still start the agent, says so, and how to release it. */
const mayStartMessage = (agentId: string, op: string): string => `Paseo does not show the claude agent ${agentId} yet, though its create was sent, so it may still start in the worktree. Once it appears, run teamai workflow cancel ${RUN} again, which stops it. If it never appears in Paseo, the create was refused: delete ${path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', `${op}.json`)} and run teamai workflow cancel ${RUN} again.`;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `holds` does, as a state outside the runtime's own lines shows it, for at most `ms`. */
async function until(holds: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !holds(); await delay(25)) if (Date.now() > end) throw new Error(`not so within ${ms} ms`);
}

/** The Paseo workspace the fake daemon opened on the worktree. */
const worktreeWorkspace = (): string | undefined => (JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { workspaces: Record<string, string> }).workspaces[fs.realpathSync(worktree)];

const promptRequest = (handle: string, op: string, lease: Partial<z.input<typeof PromptLeaseSchema>> = {}): z.input<typeof PromptRequestSchema> => ({
  type: 'prompt', op, handle, env: { TEAMAI_WORKFLOW_RESULT: path.join(dir, 'out', 'result.json'), STEP_TOKEN: 'from-teamai' }, unset: [], cwd: worktree,
  lease: {
    step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false,
    prompt: `Review the change.\n\nWrite the workflow result as JSON to ${path.join(dir, 'out', 'result.json')}. Write {"output": …}.`, result: path.join(dir, 'out', 'result.json'),
    ...lease,
  },
});

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-paseo-runtime-')));
  worktree = path.join(dir, 'worktree');
  daemonState = path.join(dir, 'daemon');
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.join(dir, 'out'));
  daemon = await startFakeDaemon({ state: daemonState, port: 0 });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.kill()));
  await daemon.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('teamai-runtime-paseo', () => {
  it('offers prompt steps only, in the checkout, a new or continued worktree, or a clone or team clone teamai prepares, with the role teamai delivered there, with no env, token count or unattended mode, for the tools the daemon can run', async () => {
    // The daemon runs on this machine, where `codex login status` says Codex is signed in.
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'], opencode: ['opencode/beam-free'] }, codex_login: 'signed_in' });

    expect(await ready(start())).toEqual({
      type: 'init', ok: true, prompt: true, confinedPrompt: true,
      can: {
        exec: false, setup: false, hitl: false, unattended: false, env: false, tokens: false, max_turns: false, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], role: true, tools: ['claude', 'codex', 'opencode'],
        confined: [{ level: 'best-effort', access: 'read', tools: ['claude', 'codex', 'opencode'] }],
      },
    });
  });

  it('offers neither a step nor a judge on a tool installed but signed out, which Paseo still calls available', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] }, sign_in: { claude: 'signed_out' } });

    expect(await ready(start())).toMatchObject({ ok: true, can: { tools: ['opencode'], confined: [{ tools: ['opencode'] }] } });
  });

  it('fails init, saying what each tool lacks and how to sign it in, when the daemon can run none of them', async () => {
    // OpenCode reaches no model provider: Paseo lists no model for it, though its own free models need no sign-in.
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'], opencode: [] }, sign_in: { claude: 'signed_out' }, codex_login: 'signed_out' });

    expect(await ready(start())).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'tool_unavailable',
        message: `The Paseo daemon at ${daemon.url} runs no tool teamai-runtime-paseo can use. claude: signed out; run \`claude auth login\` on the daemon's host. codex: signed out; run \`codex login\` on the daemon's host. opencode: reaches no model provider; run \`opencode auth login\` on the daemon's host, then \`paseo restart\`.`,
      },
    });
  });

  it('does not offer OpenCode where Paseo shares OpenCode\'s own background server, which takes no environment for an agent', async () => {
    behave({ models: { opencode: ['opencode/beam-free'] }, opencode_server: 'http://127.0.0.1:49374' });

    expect(await ready(start())).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'tool_unavailable',
        message: `The Paseo daemon at ${daemon.url} runs no tool teamai-runtime-paseo can use. opencode: Paseo runs it on OpenCode's background server at http://127.0.0.1:49374, which takes no environment for an agent, and teamai gives each step TEAMAI_RUN_DIR; stop that server with \`opencode service stop\` on the daemon's host, then \`paseo restart\`.`,
      },
    });
  });

  it('offers Codex on a daemon on this machine only when `codex login status` says it is signed in', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out' });

    expect(await ready(start())).toMatchObject({ ok: true, can: { tools: ['claude'], confined: [{ tools: ['claude'] }] } });
  });

  it('does not offer a Codex the daemon has not installed, though this machine has a signed-in codex', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho \'Logged in using ChatGPT\' >&2\n', { mode: 0o755 });
    behave({ models: { claude: ['claude-opus-5-5'] } });

    expect(await ready(start({ PATH: `${bin}${path.delimiter}${String(process.env.PATH)}` }))).toMatchObject({ ok: true, can: { tools: ['claude'], confined: [{ tools: ['claude'] }] } });
  });

  it('asks the codex the daemon resolves on its own PATH, not the one on the runtime\'s PATH', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho \'Logged in using ChatGPT\' >&2\n', { mode: 0o755 });
    // The daemon resolves a codex that holds no install, so the runtime's signed-in one is never asked.
    behave({ models: { codex: ['gpt-6.1-sol'] } });

    expect(await ready(start({ PATH: `${bin}${path.delimiter}${String(process.env.PATH)}` }))).toMatchObject({
      ok: false, error: { code: 'tool_unavailable', message: expect.stringMatching(/ codex: `\/\S+\/host-bin\/codex login status` did not answer \(.+\); run it on the daemon's host to see why\.$/) },
    });
  });

  it.each([
    ['a binary not named codex', (bin: string) => path.join(bin, 'helper')],
    ['a relative codex, which would resolve on the runtime\'s PATH', () => 'codex'],
  ])('runs nothing when the daemon resolves Codex to %s, and says so', async (_, resolvedIn) => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const ran = path.join(dir, 'ran');

    for (const name of ['helper', 'codex']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ntouch ${ran}\necho 'Logged in using ChatGPT' >&2\n`, { mode: 0o755 });
    const resolved = resolvedIn(bin);
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_path: resolved });

    expect(await ready(start({ PATH: `${bin}${path.delimiter}${String(process.env.PATH)}` }))).toMatchObject({
      ok: false,
      error: { code: 'tool_unavailable', message: expect.stringContaining(` codex: Paseo resolves it to "${resolved}", which is not an absolute path to a codex; run \`paseo provider diagnostic codex\` on the daemon's host to see why.`) },
    });
    expect(fs.existsSync(ran)).toBe(false);
  });

  it.each([
    ['win32', 'C:\\tools\\codex.exe', true],
    ['win32', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd', true],
    ['win32', 'C:\\Tools\\Codex.EXE', true],
    ['win32', 'C:\\tools\\codex', false],
    ['win32', 'C:\\tools\\codex.ps1', false],
    ['win32', 'C:\\tools\\helper.exe', false],
    ['win32', 'codex.exe', false],
    ['linux', '/usr/local/bin/codex', true],
    ['linux', '/usr/local/bin/codex.exe', false],
    ['darwin', '/opt/homebrew/bin/Codex', false],
  ] as const)('on %s, runs the Codex the daemon resolves to %s: %s', (platform, resolved, runs) => {
    expect(isCodexExecutable(resolved, platform)).toBe(runs);
  });

  it('stops every process of a `codex login status` that does not answer in time, as an npm shim leaves its native codex', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const native = path.join(dir, 'native.pid');
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nsh -c 'echo $$ > ${native}; exec sleep 60' &\nwait\n`, { mode: 0o755 });
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_path: path.join(bin, 'codex') });

    expect(await ready(start())).toMatchObject({ ok: false, error: { code: 'tool_unavailable', message: expect.stringContaining('login status` did not answer') } });
    const pid = Number(fs.readFileSync(native, 'utf8'));
    await expect.poll(() => {
      try {
        process.kill(pid, 0);

        return 'running';
      } catch {
        return 'gone';
      }
    }, { timeout: 3_000 }).toBe('gone');
  }, 20_000);

  it('says it cannot tell, rather than signed out, when `codex login status` gives neither answer', async () => {
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_login: 'unknown' });

    expect(await ready(start())).toMatchObject({
      ok: false,
      error: { code: 'tool_unavailable', message: expect.stringMatching(/ codex: `\/\S+\/host-bin\/codex login status` gave no sign-in answer \(exit 2: error: unrecognized subcommand: status\); run it on the daemon's host to see why\.$/) },
    });
  });

  it('does not offer Codex on a daemon at an address that is not loopback, whose host teamai cannot ask, and says so', async () => {
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_login: 'signed_in' });
    // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
    const url = daemon.url.replace('127.0.0.1', '0.0.0.0');

    expect(await ready(start(), { options: { url } })).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'tool_unavailable',
        message: `The Paseo daemon at ${url} runs no tool teamai-runtime-paseo can use. codex: teamai checks Codex's sign-in only on a daemon at a loopback address, and ${url} is not one.`,
      },
    });
  });

  it('does not use a Claude whose sign-in Paseo does not report, and says so', async () => {
    behave({ models: { claude: ['claude-opus-5-5'] }, sign_in: { claude: 'unreported' } });

    expect(await ready(start())).toMatchObject({
      ok: false, error: { code: 'tool_unavailable', message: expect.stringContaining('claude: Paseo does not report whether it is signed in; run `paseo provider diagnostic claude` on the daemon\'s host to see its Auth line.') },
    });
  });

  it('fails init, saying to install one, when the daemon has none of the tools installed', async () => {
    behave({ models: {} });

    expect(await ready(start())).toEqual({
      type: 'init', ok: false,
      error: { code: 'tool_unavailable', message: `The Paseo daemon at ${daemon.url} has none of claude, codex or opencode installed. Install one on the daemon's host, and sign in to it there.` },
    });
  });

  it('runs a prompt step as a Paseo agent in teamai\'s worktree, and ends finished with the tool\'s session and the output the agent wrote', async () => {
    behave({ output: { verdict: 'approve', findings: 2 } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.send(promptRequest(handle, 'op-0000000b'));

    await runtime.next(isOp('op-0000000b', 'accepted'));
    const end = await runtime.next(isEnd('op-0000000b'));
    const [create] = received();
    expect(end).toEqual({ op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: `fake-session-${String(create?.agentId)}` }, result: { output: { verdict: 'approve', findings: 2 } } });
    expect(create).toMatchObject({
      type: 'agent.create.request',
      idempotencyKey: 'op-0000000b',
      // The mode Paseo sets as Claude's default, as the member's own agents start in.
      config: { provider: 'claude', model: 'claude-opus-5-5', modeId: 'auto', cwd: worktree, title: `teamai review · ${RUN}` },
    });
    // `paseo ls --label teamai-run=<run>` lists a run's agents, and `teamai-step` one step's.
    expect(create?.labels).toEqual({ 'teamai-attempt': `${RUN}/${ATTEMPT}`, 'teamai-run': RUN, 'teamai-step': 'review' });
    // The result file and the run's scratch directory, and only they, are allowed without asking, as teamai's own launch
    // allows the result file.
    expect(create).toMatchObject({ config: { providerOptions: { allowedTools: [`Edit(/${path.join(dir, 'out', 'result.json')})`, `Edit(/${path.join(dir, 'run')}/**)`] } } });
    // Only the run directory's name crosses, so $TEAMAI_RUN_DIR works in the agent's shell: Paseo keeps a create's env in
    // plain text, so nothing of the step's env does.
    expect(create).toHaveProperty('env', { TEAMAI_RUN_DIR: path.join(dir, 'run') });
  });

  it('starts a Codex agent in the mode Paseo sets as its default, auto-review, on the daemon\'s default model, writing the result file\'s directory and the run\'s scratch directory without asking', async () => {
    behave({ output: { verdict: 'approve' }, codex_login: 'signed_in' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex' }, result: { output: { verdict: 'approve' } } });
    // Codex's `auto-review` mode writes its worktree without asking, and asks before writing anywhere else.
    expect(received()).toMatchObject([{
      config: { provider: 'codex', model: 'gpt-6.1-sol', modeId: 'auto-review', cwd: worktree, providerOptions: { sandbox_workspace_write: { writable_roots: [path.join(dir, 'out'), path.join(dir, 'run')] } } },
    }]);
  });

  it('starts a tool whose Paseo default is a bypass mode in the next tighter mode Paseo lists, never in the bypass mode', async () => {
    // Paseo marks Claude's bypassPermissions and Codex's full-access as modes that never ask.
    behave({ output: { ok: true }, codex_login: 'signed_in', default_modes: { claude: 'bypassPermissions', codex: 'full-access' } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    runtime.send(promptRequest(handle, 'op-0000000c', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'finished' });
    expect(received().map((create) => create.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'claude', modeId: 'auto' }),
      expect.objectContaining({ provider: 'codex', modeId: 'auto-review' }),
    ]));
  });

  it('does not offer a tool whose Paseo default mode is not one Paseo lists for it, saying so, and creates no agent', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] }, default_modes: { claude: 'gone' } });
    const runtime = start();

    expect(await ready(runtime)).toMatchObject({ ok: true, can: { tools: ['opencode'] } });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed',
      failure: { code: 'tool_unavailable', message: 'teamai-runtime-paseo did not offer claude: Paseo sets its default mode to gone, which it does not list for claude (plan, default, acceptEdits, auto, bypassPermissions); run `paseo provider ls` on the daemon\'s host to see its modes.' },
    });
    expect(received()).toEqual([]);
  });

  it('refuses a step on a tool it did not offer, saying why, and creates no agent', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed', failure: { code: 'tool_unavailable', message: 'teamai-runtime-paseo did not offer codex: signed out; run `codex login` on the daemon\'s host.' },
    });
    expect(received()).toEqual([]);
  });

  it('starts a new agent for a step that asks to resume a session, and says it did not resume it', async () => {
    behave({ output: { verdict: 'approve' } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.send(promptRequest(handle, 'op-0000000b', { resume: 'session-of-an-earlier-pass' }));

    const end = await runtime.next(isEnd('op-0000000b'));
    const [create] = received();
    expect(end).toEqual({ op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: `fake-session-${String(create?.agentId)}` }, result: { output: { verdict: 'approve' } } });
    expect(JSON.stringify(create)).not.toContain('session-of-an-earlier-pass');
  });

  it('offers a judge for the tools the daemon signs in, though teamai gives it no credential or login', async () => {
    behave({ models: { claude: ['claude-opus-5-5'] } });
    const runtime = start();

    // teamai refuses a credential or a login for a runtime that launches agents its own way, so this is what it sends.
    runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { url: daemon.url }, credentials: { env: [], logins: [] } });

    expect(await runtime.next(isInit)).toMatchObject({ ok: true, confinedPrompt: true, can: { tools: ['claude'], confined: [{ level: 'best-effort', access: 'read', tools: ['claude'] }] } });
  });

  it('fails a step whose model the daemon lacks as model_unavailable, naming what it offers, and creates no agent', async () => {
    behave({ models: { claude: ['claude-sonnet-5-5'] } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { model: { name: 'claude-opus-5-5' } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'model_unavailable', message: `The Paseo daemon at ${daemon.url} has no claude model claude-opus-5-5. It offers: claude-sonnet-5-5.` },
    });
    // Accepted before Paseo lists the models, which may take long; the failure follows, with no agent created.
    expect(runtime.lines.filter((line) => 'op' in line && line.op === 'op-0000000b').map((line) => ('event' in line ? line.event : ''))).toEqual(['accepted', 'failed']);
    expect(received()).toEqual([]);
  });

  it('runs the step\'s effort as the model\'s thinking option, and fails an effort the model lacks', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b', { model: { name: 'claude-opus-5-5', effort: 'high' } }));
    runtime.send(promptRequest(handle, 'op-0000000c', { model: { name: 'claude-opus-5-5', effort: 'ultra' } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'failed', failure: { code: 'model_unavailable', message: expect.stringContaining('no effort ultra for claude model claude-opus-5-5') } });
    expect(received()).toEqual([expect.objectContaining({ config: expect.objectContaining({ model: 'claude-opus-5-5', thinkingOptionId: 'high' }) })]);
  });

  it('starts an OpenCode agent with no mode, as Paseo starts one it sets no default mode for, on the daemon\'s default model when the step names none, writing the result file\'s directory and the run\'s scratch directory without asking', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'opencode', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode' } });
    const [create] = received();
    expect(create).toMatchObject({ config: { provider: 'opencode', model: 'opencode/beam-free' } });
    expect(create).not.toHaveProperty('config.modeId');
    // OpenCode asks before it touches a directory outside its project (`external_directory: ask`): Paseo passes this rule
    // to the agent's session, so the two teamai writes outside the worktree are allowed, and only they.
    expect(create).toHaveProperty('config.providerOptions', { permission: { external_directory: { [`${path.join(dir, 'out')}/*`]: 'allow', [`${path.join(dir, 'run')}/*`]: 'allow' } } });
  });

  it('cancels a running prompt: the agent is cancelled, and the prompt ends cancelled though Paseo reports the agent idle', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('fails a cancel Paseo refuses, saying its agent may still run, rather than ending cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    const end = await runtime.next(isEnd('op-0000000b'));
    const [create] = received();

    expect(end).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo did not cancel the claude agent ${String(create?.agentId)}: Agent is busy. It may still run in the worktree; stop it in the Paseo app.` },
    });
  });

  it('resumes on the same agent after it is killed with -9 once the agent was created, and creates no second one', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { verdict: 'approve' } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    second.send(promptRequest(handle, 'op-0000000b'));
    await second.next(isOp('op-0000000b', 'accepted'));
    fs.writeFileSync(release, '');

    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
    const agents = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, unknown> };
    expect(Object.keys(agents.agents)).toHaveLength(1);
  });

  it('cancels the agent of a prompt whose runtime was killed with -9, and ends it cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await second.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('ends a prompt cancelled only once Paseo cancels its agent, and fails it when Paseo refuses late', async () => {
    behave({ ask_permission: true, output: { ok: true }, refuse_cancel: 'Agent is busy', refuse_cancel_ms: 2500 });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
  });

  it('fails the attempt with its work kept when the daemon restarts mid-step, and a retried prompt runs again', async () => {
    behave({ hold_ms: 60_000, touch: 'work.txt', output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => fs.existsSync(path.join(worktree, 'work.txt'))).toBe(true);

    const port = Number(new URL(daemon.url).port);
    await daemon.close();
    behave({ output: { ok: true } });
    daemon = await startFakeDaemon({ state: daemonState, port });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${daemon.url} stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree; run \`teamai workflow retry\` to run the step again.` },
    });
    expect(fs.readFileSync(path.join(worktree, 'work.txt'), 'utf8')).toBe('work in progress\n');
    runtime.send(promptRequest(handle, 'op-0000000c'));
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('ends an unattended step whose agent asks for permission cancel_failed when Paseo will not stop that agent, since it may still run', async () => {
    behave({ ask_permission: true, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime, { mode: 'unattended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/asked for permission \(Run npm test\).* Paseo did not cancel the claude agent .*: Agent is busy\./) },
    });
  });

  it('reports a prompt whose cancel failed running while a retried cancel stops it, then cancelled, never the old failure', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });

    // The member stops what held the agent, and cancels the run again: Paseo stops it a moment after it answers.
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('answers a prompt resent while a retried cancel runs, in a runtime started again, as running, never with the old cancel_failed', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    first.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await first.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    await first.kill();

    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const second = start();
    await ready(second, { mode: 'recover' });
    second.send({ type: 'cancel', op: 'op-0000000b' });
    const restarted = start();
    await ready(restarted);
    restarted.send(promptRequest(handle, 'op-0000000b'));

    expect(await restarted.next(isOp('op-0000000b', 'accepted'))).toEqual({ op: 'op-0000000b', event: 'accepted' });
    restarted.send({ type: 'reattach', handle });
    expect(await restarted.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    expect(await second.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(await restarted.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
  });

  it('answers a cancel that comes while Paseo still creates the agent within 15 s of reading it, cancel_failed, since the agent may still start', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 30_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    const asked = Date.now();

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo did not finish creating the claude agent ${agentIdOf(OpIdSchema.parse('op-0000000b'))} within 10 s, so it may still start in the worktree; cancel the run again.` },
    });
    expect(Date.now() - asked).toBeLessThan(15_000);
  }, 40_000);

  it('keeps waiting for a create a timed-out cancel left, so a retried cancel and a close stop its agent once it exists', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 25_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    const stillCreating = { op: 'op-0000000b', event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo did not finish creating the claude agent /) } };
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(stillCreating);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(stillCreating);
    runtime.send({ type: 'close', handle });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> };
    // The agent was created after both cancels, and the close stopped it.
    expect(Object.values(kept.agents)).toHaveLength(1);
    expect(Object.values(kept.agents).filter((agent) => agent.status === 'running')).toEqual([]);
  }, 60_000);

  it('answers a close whose archive Paseo does not answer close_failed within 10 s, and keeps the attempt to close again', async () => {
    behave({ archive_ms: 30_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();
    const asked = Date.now();

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({
      event: 'close_failed', handle,
      failure: { code: 'close_failed', message: `Paseo did not answer the archive of workspace worktree (${String(workspace)}) within 10 s. Its agents may still run; archive it in the Paseo app.` },
    });
    expect(Date.now() - asked).toBeLessThan(12_000);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ event: 'alive', handle });
  }, 40_000);

  it('follows the agent of a create whose answer was lost, rather than fail a prompt whose agent runs', async () => {
    behave({ output: { ok: true }, lose_create_reply: true });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('ends a prompt whose create Paseo refused cancel_failed, since a refused create may still start its agent', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 1_500, refuse_create_early: 'Connection reset before the create was answered' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    const agentId = agentIdOf(OpIdSchema.parse('op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo could not create the claude agent ${agentId} (Connection reset before the create was answered), and does not show it, though it may still start. It may still run in the worktree; stop it in the Paseo app.` },
    });
    // It did start.
    await expect.poll(agentsOf, { timeout: 5_000 }).toEqual([agentId]);
  });

  it('keeps an attempt whose refused create may still start its agent, after a restart too, and closes it once Paseo shows the agent', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 8_000, refuse_create_early: 'Connection reset before the create was answered' });
    const first = start();
    await ready(first, { mode: 'attended' });
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    expect(await first.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    const agentId = agentIdOf(OpIdSchema.parse('op-0000000b'));
    const isCloseAnswer = (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event);
    const mayStart = {
      event: 'close_failed', handle,
      failure: {
        code: 'close_failed',
        message: mayStartMessage(agentId, 'op-0000000b'),
      },
    };

    first.send({ type: 'close', handle });

    expect(await first.next(isCloseAnswer)).toEqual(mayStart);
    await first.kill();
    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'close', handle });
    expect(await recovering.next(isCloseAnswer)).toEqual(mayStart);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);

    // The create lands: the next close stops the agent it started.
    await expect.poll(agentsOf, { timeout: 15_000 }).toEqual([agentId]);
    recovering.send({ type: 'close', handle });
    expect(await recovering.next(isCloseAnswer)).toEqual({ event: 'closed', handle });
    const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> };
    expect(Object.values(kept.agents).filter((agent) => agent.status === 'running')).toEqual([]);
    expect(journalFiles()).toEqual([]);
  }, 40_000);

  it('closes an attempt whose refused create never starts its agent once the record the close names is deleted', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 60_000, refuse_create_early: 'Connection reset before the create was answered' });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    const isCloseAnswer = (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event);
    runtime.send({ type: 'close', handle });
    expect(await runtime.next(isCloseAnswer)).toEqual({ event: 'close_failed', handle, failure: { code: 'close_failed', message: mayStartMessage(agentIdOf(OpIdSchema.parse('op-0000000b')), 'op-0000000b') } });

    // The person sees no such agent in Paseo, and deletes the record the message names.
    fs.rmSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.json'));
    runtime.send({ type: 'close', handle });

    expect(await runtime.next(isCloseAnswer)).toEqual({ event: 'closed', handle });
    expect(journalFiles()).toEqual([]);
    expect(agentsOf()).toEqual([]);
  });

  it('ends a prompt whose create never reached Paseo agent_create_failed, since no agent can have started', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    // The worktree is gone before the create: Paseo cannot open it as the agent's workspace, so the create is never sent.
    fs.rmSync(worktree, { recursive: true });
    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'agent_create_failed', message: expect.stringMatching(/^Paseo could not create the claude agent: /) } });
    expect(received()).toEqual([]);
  });

  it('keeps an earlier runtime\'s create uncertain when the resent prompt cannot open its workspace, ending it cancel_failed', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 6_000 });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    await first.kill();
    // The worktree is away while the resent prompt opens it, so this runtime sends no create of its own.
    const away = `${worktree}.away`;
    fs.renameSync(worktree, away);
    const second = start();
    await ready(second);

    second.send(promptRequest(handle, 'op-0000000b'));

    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    fs.renameSync(away, worktree);
    // The first runtime's create lands.
    await expect.poll(agentsOf, { timeout: 15_000 }).toEqual([agentIdOf(OpIdSchema.parse('op-0000000b'))]);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);
  }, 30_000);

  it('ends a prompt that fails once its agent exists cancel_failed, naming the cause, since the agent may still run', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(handle)}.json`), '{"kind":');

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo failed: .*\. The claude agent .* may still run in the worktree; stop it in the Paseo app\.$/s) },
    });
  });

  it('ends a cancel Paseo does not answer cancel_failed within 10 s, inside the 15 s teamai gives it', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy', refuse_cancel_ms: 40_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    const asked = Date.now();

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo did not answer the cancel of the claude agent ${String(received()[0]?.agentId)} within 10 s. It may still run in the worktree; stop it in the Paseo app.` },
    });
    expect(Date.now() - asked).toBeLessThan(15_000);
  }, 30_000);

  it('fails an unattended step whose agent asks for permission, naming the mode, and stops the agent', async () => {
    behave({ ask_permission: true, output: { ok: true } });
    const runtime = start();
    await ready(runtime, { mode: 'unattended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: {
        code: 'tool_failed',
        message: 'The claude agent asked for permission (Run npm test) in Paseo mode auto, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.',
      },
    });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
  });

  it('waits in an attended run until the person answers the permission request in Paseo, then finishes', async () => {
    behave({ ask_permission: true, output: { ok: true } });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    const agentId = String(received()[0]?.agentId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toEqual([]);

    fs.writeFileSync(path.join(daemonState, 'answers', agentId), 'allow');

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('takes interactive steps in an attended run only, where a person can work in the agent in the Paseo app', async () => {
    expect(await ready(start(), { mode: 'attended' })).toMatchObject({ ok: true, can: { hitl: true } });
    expect(await ready(start(), { mode: 'unattended' })).toMatchObject({ ok: true, can: { hitl: false } });
  });

  it('runs an interactive step as an agent the person works with in Paseo, ending it only once the agent wrote the result, though it idles between their turns', async () => {
    // The agent's first turn ends with no result, as a turn that asks the person something does.
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { interactive: true }));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    expect(received()[0]).toMatchObject({ initialPrompt: expect.stringMatching(/^This step is interactive: work through it with the person in this Paseo agent\. Write the result file only once they say the step is done\.\n\nReview the change\./) });

    // Idle, with no result: the person may still be in it.
    await delay(3_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toEqual([]);

    // The person said it is done, and the agent's next turn wrote the result.
    fs.writeFileSync(path.join(dir, 'out', 'result.json'), JSON.stringify({ output: { agreed: true } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { agreed: true } } });
  });

  it('fails an interactive step, as any step, once its agent idles on a result file that is not a workflow result', async () => {
    behave({ result: 'not a result' });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { interactive: true }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  it('shows the workspace when it opens, and the agent with a link to it in Paseo in a display event once the agent exists', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();

    expect(runtime.lines.find(isOp('op-0000000a', 'ready'))).toEqual({ op: 'op-0000000a', event: 'ready', display: { label: 'Paseo workspace worktree', fields: { workspace, daemon: 'Paseo 0.14.0' } } });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const accepted = await runtime.next(isOp('op-0000000b', 'accepted'));
    const shown = await runtime.next(isOp('op-0000000b', 'display'));
    await runtime.next(isEnd('op-0000000b'));
    const agentId = String(received()[0]?.agentId);
    const agent = { label: `teamai review · ${RUN}`, url: `paseo://h/srv_fake0001/agent/${agentId}`, fields: { agent: agentId, workspace, model: 'claude/claude-opus-5-5' } };

    expect(accepted).toEqual({ op: 'op-0000000b', event: 'accepted' });
    expect(shown).toEqual({ op: 'op-0000000b', event: 'display', display: agent });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ display: agent });
  });

  it('accepts a prompt before Paseo has created its agent, and sends the agent\'s link once it exists', async () => {
    behave({ output: { ok: true }, create_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    await runtime.next(isOp('op-0000000b', 'accepted'));
    expect(agentsOf()).toEqual([]);
    expect(await runtime.next(isOp('op-0000000b', 'display'))).toMatchObject({ display: { url: `paseo://h/srv_fake0001/agent/${agentIdOf(OpIdSchema.parse('op-0000000b'))}` } });
    expect(agentsOf()).toEqual([agentIdOf(OpIdSchema.parse('op-0000000b'))]);
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
  });

  it('accepts a prompt before Paseo lists its models, and a cancel then ends it cancelled with no agent ever created', async () => {
    behave({ output: { ok: true }, models_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    const asked = Date.now();

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(Date.now() - asked).toBeLessThan(10_000);
    // Past the listing: the agent is never created.
    await delay(4_000);
    expect(received()).toEqual([]);
    expect(agentsOf()).toEqual([]);
  });

  it('closes an attempt whose prompt waits for its models, ending the prompt cancelled first, and creates no agent after', async () => {
    behave({ output: { ok: true }, models_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    const events = runtime.lines.map((line) => ('event' in line ? `${'op' in line ? line.op : 'handle'} ${line.event}` : ''));
    expect(events.indexOf('op-0000000b cancelled')).toBeGreaterThan(-1);
    expect(events.indexOf('op-0000000b cancelled')).toBeLessThan(events.indexOf('handle closed'));
    await delay(4_000);
    expect(received().map((request) => request.type)).toEqual(['archive_workspace_request']);
    expect(agentsOf()).toEqual([]);
    expect(journalFiles()).toEqual([]);
  });

  it('ends cancelled, in recover mode, a prompt whose runtime was killed before it created the agent, and creates none', async () => {
    behave({ output: { ok: true }, models_ms: 3_000 });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await first.kill();

    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    recovering.send({ type: 'close', handle });
    expect(await recovering.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().map((request) => request.type)).toEqual(['archive_workspace_request']);
    expect(agentsOf()).toEqual([]);
  });

  it('runs a prompt resent after its runtime was killed before it created the agent, creating it once', async () => {
    behave({ output: { ok: true }, models_ms: 2_000 });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    second.send(promptRequest(handle, 'op-0000000b'));

    expect(await second.next(isOp('op-0000000b', 'accepted'))).toEqual({ op: 'op-0000000b', event: 'accepted' });
    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
    expect(agentsOf()).toEqual([agentIdOf(OpIdSchema.parse('op-0000000b'))]);
  });

  it('ends a prompt once when its cancel cannot read the prompt\'s record, though its agent then ends', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.json'), '{not json');

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo failed: .*\. Its agent may still run in the worktree; stop it in the Paseo app\.$/s) } });
    fs.writeFileSync(release, '');
    await delay(3_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);
  });

  it('ends a prompt once when its cancel cannot record itself, and a later cancel, once it can, stops the agent', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    // The cancel marker cannot be written where a directory stands.
    const marker = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.cancel');
    fs.mkdirSync(marker);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(' may still run in the worktree; stop it in the Paseo app.') } });
    // The agent ends on its own; the prompt already ended, so it is not ended again.
    fs.writeFileSync(release, '');
    await delay(3_000);
    fs.rmdirSync(marker);
    await delay(1_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
  });

  it('keeps the cancel_failed of a cancel that could not record itself, so a reattach before the retry reports it', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    // The cancel marker cannot be written where a directory stands; the prompt's record still can.
    const marker = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.cancel');
    fs.mkdirSync(marker);
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    // The agent ends on its own, and nothing follows it any more.
    fs.writeFileSync(release, '');
    const statusOf = (): string | undefined => (JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> }).agents[agentIdOf(OpIdSchema.parse('op-0000000b'))]?.status;
    await expect.poll(statusOf).toBe('idle');
    fs.rmdirSync(marker);
    const isAlive = (line: RuntimeMessage): boolean => 'event' in line && line.event === 'alive';

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next(isAlive)).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'failed', failure: { code: 'cancel_failed' } }] });
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next(isAlive)).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('keeps the failure a prompt\'s request ended with, so a reattach and a repeated prompt report it rather than run it again', async () => {
    behave({ output: { ok: true }, refuse_fetch: 'Agent store unavailable' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const ended = await runtime.next(isEnd('op-0000000b'));
    expect(ended).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo failed: Agent store unavailable\. /) } });
    behave({ output: { ok: true } });
    const isAlive = (line: RuntimeMessage): boolean => 'event' in line && line.event === 'alive';

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next(isAlive)).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'failed', failure: { code: 'cancel_failed' } }] });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(ended);
    expect(received()).toEqual([]);
  });

  it('ends a prompt whose request failed once, though it could not record the failure and its place closes afterwards', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, models_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    // While Paseo lists the models, the prompts' records become read-only: the agent record cannot be saved, nor the failure.
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.chmodSync(ops, 0o555);
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    fs.chmodSync(ops, 0o755);
    const isCloseAnswer = (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event);

    runtime.send({ type: 'close', handle });

    expect(await runtime.next(isCloseAnswer)).toEqual({ event: 'closed', handle });
    expect(runtime.lines.filter(isEnd('op-0000000b')).map((line) => ('event' in line ? line.event : undefined))).toEqual(['failed']);
  });

  it('reports the failure of a prompt it could not record to a reattach in the same process, not running', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, models_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.chmodSync(ops, 0o555);
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    fs.chmodSync(ops, 0o755);

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'failed', failure: { code: 'paseo_failed' } }] });
  });

  it('answers every cancel in recover mode, though the first could not record itself', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.kill();
    const marker = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.cancel');
    fs.mkdirSync(marker);

    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    fs.rmdirSync(marker);
    recovering.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
  });

  it('ends a cancelled prompt only once its agent stopped running, though Paseo answers the cancel before', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(stopped()).toEqual([{ agentId: String(received()[0]?.agentId), status: 'idle' }]);
  });

  it('fails a cancel whose agent still runs well after Paseo answered it, and says to stop it in the app', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 60_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo cancelled the claude agent ${String(received()[0]?.agentId)}, but it still ran 10 s later. It may still change the worktree; stop it in the Paseo app.` },
    });
  }, 30_000);

  it('says the attempt closed only once the agents of its archived workspace stopped running', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(stopped()).toEqual([{ agentId: String(received()[0]?.agentId), status: 'closed' }]);
  });

  it.each([
    ['while Paseo creates its agent', 'create'],
    ['while its agent waits on a permission nobody answered', 'display'],
  ] as const)('ends a prompt cancelled, once, before its place closes %s', async (_, reached) => {
    behave({ create_ms: 1_000, ask_permission: true, hold_ms: 60_000, archive_ms: 100 });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));

    if (reached === 'create') await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    else await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    await delay(2_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toEqual([{ op: 'op-0000000b', event: 'cancelled' }]);
    const events = runtime.lines.map((line) => ('event' in line ? `${'op' in line ? line.op : 'handle'} ${line.event}` : ''));
    expect(events.indexOf('op-0000000b cancelled')).toBeLessThan(events.indexOf('handle closed'));
    expect(journalFiles()).toEqual([]);
  });

  it('archives the Paseo workspace when teamai closes the attempt, and keeps nothing of it', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));
    const workspace = worktreeWorkspace();

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'gone')).toEqual({ event: 'gone', handle });
  });

  it('never archives a workspace the member had open in Paseo on that directory before teamai opened it, as on their checkout for a read-only step, and stops only its own agents', async () => {
    // The member works in this directory in Paseo, as in their own checkout, which a read-only step runs in.
    behave({ output: { ok: true }, member_workspaces: [worktree] });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
    // The member's workspace stays open in Paseo, on the same id.
    expect(worktreeWorkspace()).toBe(workspace);
  });

  it('archives a workspace once though a second attempt opens its directory while Paseo makes it for the first', async () => {
    behave({ output: { ok: true }, open_reply_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const first = await runtime.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    runtime.send(openRequest('op-0000000c', 'a4567cdef'));
    const second = await runtime.next(isOp('op-0000000c', 'accepted'));
    await runtime.next(isOp('op-0000000a', 'ready'));
    await runtime.next(isOp('op-0000000c', 'ready'));
    const workspace = worktreeWorkspace();

    for (const accepted of [first, second]) {
      const handle = 'handle' in accepted ? accepted.handle : undefined;
      runtime.send({ type: 'close', handle: String(handle) });
      expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    }

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('archives a workspace once though another runtime on the same journal opens its directory while Paseo makes it for this one', async () => {
    behave({ output: { ok: true }, open_reply_ms: 1_500 });
    const runtime = start();
    const other = start();
    await ready(runtime);
    await ready(other);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const first = await runtime.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    other.send(openRequest('op-0000000c', 'a4567cdef'));
    const second = await other.next(isOp('op-0000000c', 'accepted'));
    await runtime.next(isOp('op-0000000a', 'ready'));
    await other.next(isOp('op-0000000c', 'ready'));
    const workspace = worktreeWorkspace();

    for (const [owner, accepted] of [[runtime, first], [other, second]] as const) {
      const handle = 'handle' in accepted ? accepted.handle : undefined;
      owner.send({ type: 'close', handle: String(handle) });
      expect(await owner.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    }

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('fails an open it cannot journal before asking Paseo, and opens nothing there', async () => {
    const runtime = start();
    await ready(runtime);
    // A file where the journal keeps its opens in flight, so none can be written there.
    fs.mkdirSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'opening'), '');
    runtime.send(openRequest('op-0000000a', ATTEMPT));

    expect(await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line))).toMatchObject({
      event: 'failed', failure: { code: 'workspace_failed', message: expect.stringMatching(/^teamai-runtime-paseo could not journal its open of .+ before asking Paseo, so it opened nothing: /) },
    });
    expect(fs.existsSync(path.join(daemonState, 'agents.json')) ? worktreeWorkspace() : undefined).toBeUndefined();
  });

  it('archives the workspace a runtime made before it died mid-open, once a runtime started again opens the attempt', async () => {
    behave({ output: { ok: true }, open_reply_ms: 60_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    await runtime.kill();
    const workspace = worktreeWorkspace();

    const again = start();
    await ready(again);
    again.send(openRequest('op-0000000c', ATTEMPT));
    expect(await again.next(isOp('op-0000000c', 'accepted'))).toMatchObject({ handle: 'handle' in accepted ? accepted.handle : undefined });
    expect(await again.next((line) => isOp('op-0000000c', 'ready')(line) || isOp('op-0000000c', 'failed')(line))).toMatchObject({ event: 'ready' });
    again.send({ type: 'close', handle: String('handle' in accepted ? accepted.handle : '') });
    expect(await again.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'closed' });

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('archives the workspace it opened on a directory the member opened in Paseo under another path, which Paseo keeps apart, and leaves the member\'s', async () => {
    // The member opened the checkout through a link to it; Paseo matches a directory's workspace by its path, not its target.
    const link = path.join(dir, 'checkout-link');
    fs.symlinkSync(worktree, link);
    behave({ output: { ok: true }, member_workspaces: [link] });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  it('answers close_failed when Paseo will not archive the workspace, and keeps the attempt to close again', async () => {
    behave({ output: { ok: true }, refuse_archive: 'Workspace is busy' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({
      event: 'close_failed', handle,
      failure: { code: 'close_failed', message: `Paseo did not archive workspace worktree (${String(workspace)}): Workspace is busy. Its agents may still run; archive it in the Paseo app.` },
    });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ event: 'alive', handle });
  });

  it('archives a workspace two attempts share only when the last of them closes, one whose open is still in flight included', async () => {
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const workspace = worktreeWorkspace();
    behave({ open_ms: 2_000 });
    runtime.send(openRequest('op-0000000c', 'a4567cdef'));
    const accepted = await runtime.next(isOp('op-0000000c', 'accepted'));
    const second = 'handle' in accepted ? String(accepted.handle) : '';
    const archives = (): unknown[] => received().filter((request) => request.type === 'archive_workspace_request');

    runtime.send({ type: 'close', handle: first });
    expect(await runtime.next((line) => 'event' in line && line.event === 'closed')).toEqual({ event: 'closed', handle: first });
    expect(archives()).toEqual([]);
    expect(await runtime.next(isOp('op-0000000c', 'ready'))).toMatchObject({ display: { fields: { workspace } } });
    runtime.send({ type: 'close', handle: second });
    expect(await runtime.next((line) => 'event' in line && line.event === 'closed')).toEqual({ event: 'closed', handle: second });
    expect(archives()).toMatchObject([{ workspaceId: workspace }]);
  });

  it('accepts an open before Paseo opens the worktree as a workspace, and sends ready with that workspace once it does', async () => {
    behave({ open_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));

    expect(await runtime.next(isOp('op-0000000a', 'accepted'))).toEqual({ op: 'op-0000000a', event: 'accepted', handle: `worktree/${RUN}/${ATTEMPT}` });
    expect(worktreeWorkspace()).toBeUndefined();
    const shown = await runtime.next(isOp('op-0000000a', 'ready'));
    expect(shown).toEqual({ op: 'op-0000000a', event: 'ready', display: { label: 'Paseo workspace worktree', fields: { workspace: worktreeWorkspace(), daemon: 'Paseo 0.14.0' } } });
  });

  it('closes an attempt whose open is still in flight once Paseo opened its workspace, and archives it', async () => {
    behave({ open_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));
    const handle = 'handle' in accepted ? String(accepted.handle) : '';

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toHaveLength(1);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && ['alive', 'gone'].includes(line.event))).toEqual({ event: 'gone', handle });
  });

  it('reads an attempt\'s prompts from its own index alone, so a record outside it never blocks its reattach or close', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const root = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo');
    // A place with no index of its own, as one journaled before the index was kept, and another attempt's damaged record.
    fs.rmSync(path.join(root, 'handles', encodeURIComponent(handle)), { recursive: true });
    fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ops', 'op-0000000f.json'), '{not json');

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next((line) => 'handle' in line && !('op' in line) && ['alive', 'gone', 'failed'].includes(line.event))).toMatchObject({ event: 'alive', handle, ops: [] });
    runtime.send({ type: 'close', handle });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
  });

  it('stops only its own agents when another attempt shares its workspace, and leaves that attempt running', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const second = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    runtime.send(promptRequest(first, 'op-0000000b'));
    runtime.send(promptRequest(second, 'op-0000000d'));
    await runtime.next(isOp('op-0000000b', 'display'));
    await runtime.next(isOp('op-0000000d', 'display'));

    runtime.send({ type: 'close', handle: first });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: first });
    expect(stopped()).toEqual([{ agentId: agentIdOf(OpIdSchema.parse('op-0000000b')), status: 'idle' }]);
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
    runtime.send({ type: 'reattach', handle: second });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ handle: second, ops: [{ op: 'op-0000000d', state: 'running' }] });
  });

  it('keeps an attempt whose agent still runs when another attempt shares its workspace, so it can be closed again', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy', stop_lag_ms: 60_000 });
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const second = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    const isClose = (handle: string) => (line: RuntimeMessage): boolean => 'event' in line && ['closed', 'close_failed'].includes(line.event) && 'handle' in line && line.handle === handle;
    const archives = (): unknown[] => received().filter((request) => request.type === 'archive_workspace_request');
    runtime.send(promptRequest(first, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    const agent = agentIdOf(OpIdSchema.parse('op-0000000b'));

    runtime.send({ type: 'close', handle: first });

    expect(await runtime.next(isClose(first))).toEqual({
      event: 'close_failed', handle: first,
      failure: { code: 'close_failed', message: `Paseo did not cancel the claude agent ${agent}: Agent is busy. It may still run in the worktree; stop it in the Paseo app.` },
    });
    runtime.send({ type: 'close', handle: second });
    expect(await runtime.next(isClose(second))).toEqual({ event: 'closed', handle: second });
    expect(archives()).toEqual([]);
    expect(stopped()).toEqual([]);
    runtime.send({ type: 'reattach', handle: first });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ handle: first, ops: [{ op: 'op-0000000b', state: 'failed' }] });

    // Paseo stops the agent once asked again: the attempt, now the workspace's last, archives it and closes.
    behave({ hold_ms: 60_000, output: { ok: true } });
    runtime.send({ type: 'close', handle: first });
    expect(await runtime.next(isClose(first))).toEqual({ event: 'closed', handle: first });
    expect(archives()).toMatchObject([{ workspaceId: workspace }]);
    expect(stopped()).toEqual([{ agentId: agent, status: 'closed' }]);
  }, 30_000);

  it('answers a place from its journal after a restart that cannot reach the daemon, and refuses to close it until it can', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await first.kill();
    const workspace = worktreeWorkspace();
    const { url } = daemon;
    await daemon.close();
    const isAnswer = (events: string[]) => (line: RuntimeMessage): boolean => 'event' in line && [...events, 'error'].includes(line.event);

    const restarted = start();
    expect(await ready(restarted, { options: { url } })).toMatchObject({ ok: false, error: { code: 'daemon_unreachable' } });
    restarted.send({ type: 'reattach', handle });
    expect(await restarted.next(isAnswer(['alive', 'gone']))).toEqual({ event: 'alive', handle, ops: [{ op: 'op-0000000b', state: 'running' }] });
    restarted.send({ type: 'collect', handle });
    expect(await restarted.next(isAnswer(['collected', 'collect_failed']))).toEqual({ event: 'collected', handle });
    restarted.send({ type: 'close', handle });
    expect(await restarted.next(isAnswer(['closed', 'close_failed']))).toEqual({
      event: 'close_failed', handle,
      failure: { code: 'daemon_unreachable', message: `teamai-runtime-paseo reaches no Paseo daemon, so it cannot stop the agents of ${handle} or archive its workspace. Start the daemon with \`paseo start\`, then close the attempt again.` },
    });
    restarted.send({ type: 'reattach', handle });
    expect(await restarted.next(isAnswer(['alive', 'gone']))).toMatchObject({ event: 'alive', handle });

    // The daemon is back, and has closed the agent it ran, as Paseo does on a restart: a runtime that reaches it archives
    // the workspace and closes.
    daemon = await startFakeDaemon({ state: daemonState, port: Number(new URL(url).port) });
    const back = start();
    await ready(back);
    back.send({ type: 'close', handle });
    expect(await back.next(isAnswer(['closed', 'close_failed']))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  }, 40_000);

  it('opens in recover mode with no daemon to reach, checking no tool and offering nothing', async () => {
    const { url } = daemon;
    await daemon.close();

    expect(await ready(start(), { mode: 'recover', options: { url } })).toEqual({ type: 'init', ok: true, can: {} });
  });

  it('stops a journaled prompt in recover mode though its tool is signed out since, reaching the daemon for the cancel and the close', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();
    behave({ sign_in: { claude: 'signed_out' } });

    const recovering = start();
    expect(await ready(recovering, { mode: 'recover' })).toEqual({ type: 'init', ok: true, can: {} });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    recovering.send({ type: 'reattach', handle });
    expect(await recovering.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
    recovering.send({ type: 'close', handle });

    expect(await recovering.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request', 'archive_workspace_request']);
  });

  it('answers a recover-mode cancel and close within 10 s of reading them while the daemon is down, keeping the attempt', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.kill();
    const { url } = daemon;
    await daemon.close();
    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });
    let asked = Date.now();

    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: {
        code: 'cancel_failed',
        message: `No Paseo daemon answered at ${url} within 10 s. Start it with \`paseo start\`, or set the runtime's url option to the daemon's address. Until then teamai-runtime-paseo cannot cancel the claude agent ${agentIdOf(OpIdSchema.parse('op-0000000b'))}, which may still run in the worktree; cancel the run again.`,
      },
    });
    const cancelMs = Date.now() - asked;
    asked = Date.now();
    recovering.send({ type: 'close', handle });
    expect(await recovering.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'close_failed', handle, failure: { code: 'daemon_unreachable' } });
    const closeMs = Date.now() - asked;
    process.stderr.write(`recover answers: cancel ${cancelMs} ms, close ${closeMs} ms\n`);
    expect(cancelMs).toBeLessThan(10_500);
    expect(closeMs).toBeLessThan(10_500);
    daemon = await startFakeDaemon({ state: daemonState, port: 0 });
  }, 40_000);

  it('answers a recover-mode cancel within 10 s while the daemon\'s address accepts connections and never answers, and stops the agent on a retry once the daemon is back', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.kill();
    const { url } = daemon;
    const port = Number(new URL(url).port);
    await daemon.close();
    // A host that takes the connection and never says hello, as a hung daemon or a firewall that holds it does.
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });
    const asked = Date.now();

    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toMatchObject({ op: 'op-0000000b', event: 'failed', failure: { code: 'cancel_failed' } });
    expect(Date.now() - asked).toBeLessThan(10_500);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    daemon = await startFakeDaemon({ state: daemonState, port });

    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
  }, 40_000);

  it('refuses to close a place whose record it cannot read, and never calls it gone', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const record = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(handle)}.json`);
    fs.writeFileSync(record, '{"kind":');
    const isAnswer = (events: string[]) => (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && [...events, 'error'].includes(line.event);

    runtime.send({ type: 'close', handle });

    expect(await runtime.next(isAnswer(['closed', 'close_failed']))).toMatchObject({ event: 'close_failed', handle, failure: { code: 'paseo_failed' } });
    expect(fs.readFileSync(record, 'utf8')).toBe('{"kind":');
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next(isAnswer(['alive', 'gone', 'failed']))).toMatchObject({ event: 'failed', handle, failure: { code: 'paseo_failed' } });
  });

  it('refuses a repeated open of an attempt whose place record it cannot read, and keeps that record', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const record = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(handle)}.json`);
    fs.writeFileSync(record, '{"kind":');

    runtime.send(openRequest('op-0000000c', ATTEMPT));

    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    expect(fs.readFileSync(record, 'utf8')).toBe('{"kind":');
  });

  it('answers and closes a healthy attempt though the record of another attempt\'s prompt cannot be read, and refuses its own unreadable one', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.writeFileSync(path.join(ops, 'op-0000000f.json'), '{"kind":');
    const isAnswer = (events: string[]) => (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && [...events, 'error'].includes(line.event);

    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next(isAnswer(['alive', 'gone', 'failed']))).toMatchObject({ event: 'alive', handle, ops: [{ op: 'op-0000000b', state: 'finished' }] });
    runtime.send({ type: 'close', handle });
    expect(await runtime.next(isAnswer(['closed', 'close_failed']))).toEqual({ event: 'closed', handle });

    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    runtime.send(promptRequest(other, 'op-0000000d'));
    await runtime.next(isEnd('op-0000000d'));
    fs.writeFileSync(path.join(ops, 'op-0000000d.json'), '{"kind":');
    runtime.send({ type: 'reattach', handle: other });
    expect(await runtime.next(isAnswer(['alive', 'gone', 'failed']))).toMatchObject({ event: 'failed', handle: other });
  });

  it('closes a healthy attempt though another attempt\'s place record cannot be read, and leaves the workspace that place may share', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(`worktree/${RUN}/a4567cdef`)}.json`), '{"kind":');

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed', 'failed', 'error'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
  });

  it('fails a request it cannot read on its own when its op or handle is new, never with an error line', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.child.stdin?.write(`${JSON.stringify({ type: 'prompt', op: 'op-0000000b', handle })}\n`);
    runtime.child.stdin?.write(`${JSON.stringify({ type: 'shut', handle: 'worktree/r4567cdef/a4567cdef' })}\n`);

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'bad_request', message: expect.stringMatching(/^teamai-runtime-paseo could not read the prompt request for op-0000000b: /) } });
    expect(await runtime.next((line) => 'handle' in line && line.handle === 'worktree/r4567cdef/a4567cdef')).toMatchObject({ event: 'failed', failure: { code: 'bad_request' } });
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'error')).toEqual([]);
  });

  it('drops a request it cannot read for a prompt it already runs, so that prompt still ends once, and fails no other request', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.child.stdin?.write(`${JSON.stringify({ type: 'stop', op: 'op-0000000b' })}\n`);
    runtime.child.stdin?.write(`${JSON.stringify({ type: 'shut', handle })}\n`);
    await delay(1_000);
    fs.writeFileSync(release, '');

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    await delay(500);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);
    expect(runtime.lines.filter((line) => 'event' in line && (line.event === 'error' || ('handle' in line && !('op' in line) && line.event === 'failed')))).toEqual([]);
  });

  it('keeps running, and ends its prompt, when it notes a dropped request after teamai stopped reading its stderr', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000e'));
    await runtime.next(isOp('op-0000000e', 'display'));
    runtime.child.stderr?.destroy();

    // Its note about the dropped request goes to a stderr nobody reads.
    runtime.child.stdin?.write(`${JSON.stringify({ type: 'stop', op: 'op-0000000e' })}\n`);
    runtime.send({ type: 'reattach', handle });
    await runtime.next((line) => 'event' in line && line.event === 'alive');
    await delay(500);
    fs.writeFileSync(release, '');

    expect(await runtime.next(isEnd('op-0000000e'))).toMatchObject({ event: 'finished' });
  });

  it('answers an open or a prompt it cannot run, before a successful init or in recover mode, with its own failure, never an error line', async () => {
    const { url } = daemon;
    await daemon.close();
    const isAnswer = (op: string) => (line: RuntimeMessage): boolean => 'event' in line && (line.event === 'error' || ('op' in line && line.op === op));

    const unstarted = start();
    expect(await ready(unstarted, { options: { url } })).toMatchObject({ ok: false, error: { code: 'daemon_unreachable' } });
    unstarted.send({ type: 'open', op: 'op-0000000a', run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} } });
    expect(await unstarted.next(isAnswer('op-0000000a'))).toEqual({
      op: 'op-0000000a', event: 'failed', failure: { code: 'not_started', message: 'teamai-runtime-paseo got open before a successful init.' },
    });

    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });
    recovering.send(promptRequest('worktree/r/a', 'op-0000000b'));
    expect(await recovering.next(isAnswer('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed', failure: { code: 'not_started', message: 'teamai-runtime-paseo opened in recover mode only stops what it ran: it got prompt.' },
    });
  });

  it.each([
    ['an option it does not take', { url: 'ws://127.0.0.1:1/ws', imgae: 'x' }, {}, { code: 'bad_option', key: 'imgae' }],
    ['no daemon at the url', { url: 'ws://127.0.0.1:1/ws' }, {}, { code: 'daemon_unreachable' }],
    ['a daemon older than the client', undefined, { version: '0.13.2' }, { code: 'daemon_version', message: expect.stringContaining('runs version 0.13.2') }],
    ['a daemon without agent receipts', undefined, { missing: ['agentRequestReceipts'] }, { code: 'daemon_version', message: expect.stringContaining('lacks agentRequestReceipts') }],
  ])('fails init on %s', async (_, options, behaviour, error) => {
    behave(behaviour);

    expect(await ready(start(), { options: options ?? { url: daemon.url } })).toEqual({ type: 'init', ok: false, error: expect.objectContaining(error) });
  });

  describe('a confined prompt, as a judge', () => {
    const SCHEMA = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
    let evidence: string;

    /** Opens a confined prompt's place, with no view of the host. */
    async function openedConfined(runtime: Runtime): Promise<string> {
      runtime.send({ type: 'open', op: 'op-0000000a', run: RUN, attempt: ATTEMPT, credentials: {} });
      const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));

      if (!('handle' in accepted) || !accepted.handle) throw new Error(`no handle in ${JSON.stringify(accepted)}`);

      return accepted.handle;
    }

    const confinedRequest = (handle: string, op: string, confined: Partial<{ level: 'best-effort' | 'verified'; access: 'answer' | 'read' | 'full' }> = {}, lease: Partial<z.input<typeof PromptLeaseSchema>> = {}): z.input<typeof PromptRequestSchema> => ({
      ...promptRequest(handle, op, { step: 'score.judge', prompt: 'Label the pass from the evidence: pass or fail.', ...lease }),
      env: {}, cwd: evidence,
      confined: { dir: evidence, level: 'best-effort', access: 'read', schema: SCHEMA, ...confined },
    });

    beforeEach(() => {
      evidence = path.join(dir, 'run', 'evidence');
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'diff.patch'), '+fix\n');
    });

    it('answers with a fresh agent whose cwd is the directory, briefed to read only it, and reports the reply at best-effort, read', async () => {
      behave({ reply: '```json\n{"label": "pass", "reasoning": "tests added"}\n```' });
      const runtime = start();
      await ready(runtime, { mode: 'attended' });
      const handle = await openedConfined(runtime);
      await runtime.next(isOp('op-0000000a', 'ready'));

      runtime.send(confinedRequest(handle, 'op-0000000b'));

      const end = await runtime.next(isEnd('op-0000000b'));
      const [create] = received();
      expect(end).toEqual({
        op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: `fake-session-${String(create?.agentId)}` },
        result: { output: { label: 'pass', reasoning: 'tests added' } }, confined: { level: 'best-effort', access: 'read' },
      });
      expect(create).toMatchObject({ type: 'agent.create.request', idempotencyKey: 'op-0000000b', config: { provider: 'claude', model: 'claude-opus-5-5', modeId: 'default', cwd: evidence } });
      // Nothing is allowed without asking, and asking ends it.
      expect(create).not.toHaveProperty('config.providerOptions');
      expect(create).not.toHaveProperty('env');
      const prompt = String(create?.initialPrompt);
      expect(prompt).toContain(`Answer from the files in ${evidence} alone. List and read them with your file tools, such as Glob, Grep and Read.`);
      expect(prompt).toContain('Change no file and run no shell command');
      expect(prompt).toContain('Label the pass from the evidence: pass or fail.');
      expect(prompt).toContain(JSON.stringify(SCHEMA));
      // The step's prompt may name another schema file; the one the request carries decides the reply's shape.
      expect(prompt).toContain('Where the prompt above names another schema, this one decides the shape of your reply.');
      expect(fs.readdirSync(evidence)).toEqual(['diff.patch']);
    });

    it('runs an OpenCode judge in its plan mode, which asks before it edits or runs anything', async () => {
      behave({ reply: '{"label": "fail"}' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', {}, { tool: 'opencode', model: undefined }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode' }, result: { output: { label: 'fail' } }, confined: { level: 'best-effort', access: 'read' } });
      expect(received()).toMatchObject([{ config: { provider: 'opencode', modeId: 'plan', cwd: evidence } }]);
    });

    it('refuses a judge on a tool it did not offer, saying why, and creates no agent', async () => {
      behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', {}, { tool: 'codex', model: undefined }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
        event: 'failed', failure: { code: 'tool_unavailable', message: 'teamai-runtime-paseo did not offer codex: signed out; run `codex login` on the daemon\'s host.' },
      });
      expect(received()).toEqual([]);
    });

    it('runs a Codex judge in its auto mode with a read-only sandbox, since each mode Paseo lists for Codex writes without asking', async () => {
      behave({ reply: '{"label": "pass"}', codex_login: 'signed_in' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', {}, { tool: 'codex', model: undefined }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex' }, result: { output: { label: 'pass' } }, confined: { level: 'best-effort', access: 'read' } });
      // `auto` asks before anything its sandbox does not allow, which ends the prompt; the sandbox reads and writes nothing.
      expect(received()).toMatchObject([{ config: { provider: 'codex', modeId: 'auto', cwd: evidence, providerOptions: { sandbox_mode: 'read-only' } } }]);
      // Codex has no file tools of its own: it reads with shell commands, which its sandbox runs without asking.
      const prompt = String(received()[0]?.initialPrompt);
      expect(prompt).toContain(`Answer from the files in ${evidence} alone. List and read them with read-only shell commands, such as ls, cat and rg, which your sandbox runs without asking.`);
      expect(prompt).toContain('Change no file and use no other tool: asking for a permission ends this run.');
      expect(prompt).not.toContain('Glob');
    });

    it.each([
      ['a verified level, which it does not reach', { level: 'verified' as const }, {}, 'confined_level', 'teamai-runtime-paseo keeps a confined prompt best-effort'],
      ['a tool Paseo does not run', {}, { tool: 'codebuddy', model: undefined }, 'tool_unavailable', 'teamai-runtime-paseo runs a confined prompt on claude, codex or opencode, not codebuddy'],
    ])('refuses %s, and creates no agent', async (_, confined, lease, code, message) => {
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', confined, lease));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code, message: expect.stringContaining(message) } });
      expect(received()).toEqual([]);
    });

    it('ends a judge that asks for permission, even in an attended run, and stops its agent', async () => {
      behave({ ask_permission: true, reply: '{"label": "pass"}' });
      const runtime = start();
      await ready(runtime, { mode: 'attended' });
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
        op: 'op-0000000b', event: 'failed',
        failure: { code: 'tool_failed', message: 'The claude agent asked for permission (Run npm test) in Paseo mode default. A confined prompt only reads its directory, so it ends rather than ask.' },
      });
      expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    });

    it('fails a judge whose reply is no JSON value', async () => {
      behave({ reply: 'The pass looks good to me.' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'The claude agent replied with no JSON value.' } });
    });

    it('archives the judge\'s Paseo workspace on close, and leaves the directory in place', async () => {
      behave({ reply: '{"label": "pass"}' });
      const runtime = start();
      await ready(runtime);
      const handle = await openedConfined(runtime);
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isEnd('op-0000000b'));

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      expect(received().filter((request) => request.type === 'archive_workspace_request')).toHaveLength(1);
      expect(fs.readdirSync(evidence)).toEqual(['diff.patch']);
    });

    it('accepts a judge before Paseo opens its directory, and a cancel then ends it cancelled with no agent ever created', async () => {
      behave({ reply: '{"label": "pass"}', open_ms: 3_000 });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      const asked = Date.now();

      runtime.send({ type: 'cancel', op: 'op-0000000b' });

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
      expect(Date.now() - asked).toBeLessThan(10_000);
      await delay(4_000);
      expect(received()).toEqual([]);
      expect(agentsOf()).toEqual([]);
    });

    it('closes a judge\'s place while Paseo opens its directory only once the judge ended cancelled, archives that workspace, and keeps nothing', async () => {
      behave({ reply: '{"label": "pass"}', open_ms: 3_000 });
      const runtime = start();
      await ready(runtime);
      const handle = await openedConfined(runtime);
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      const events = runtime.lines.map((line) => ('event' in line ? `${'op' in line ? line.op : 'handle'} ${line.event}` : ''));
      expect(events.indexOf('op-0000000b cancelled')).toBeGreaterThan(-1);
      expect(events.indexOf('op-0000000b cancelled')).toBeLessThan(events.indexOf('handle closed'));
      await delay(1_000);
      expect(received().map((request) => request.type)).toEqual(['archive_workspace_request']);
      expect(agentsOf()).toEqual([]);
      expect(journalFiles()).toEqual([]);
    });

    it.each([
      ['lists its models', { models_ms: 3_000 }, ['archive_workspace_request']],
      ['creates its agent', { create_ms: 3_000 }, ['agent.create.request', 'archive_workspace_request']],
    ] as const)('closes a judge\'s place while Paseo %s only once that ended, and leaves no agent running', async (_, slow, requests) => {
      const runtime = start();
      await ready(runtime);
      const handle = await openedConfined(runtime);
      // The judge's directory is already its place's workspace, so the launch goes straight on.
      runtime.send(confinedRequest(handle, 'op-0000000c'));
      await runtime.next(isEnd('op-0000000c'));
      behave({ reply: '{"label": "pass"}', hold_ms: 60_000, ...slow });
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      const sent = received().length;
      // The close comes once the launch reached the slow call: the create crossed the wire, or the listing is still held.
      await expect.poll(() => received().length).toBe(sent + requests.length - 1);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      await delay(4_000);
      // The judge ended once, before its place closed.
      expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);
      expect(runtime.lines.findIndex(isEnd('op-0000000b'))).toBeLessThan(runtime.lines.findIndex((line) => 'event' in line && line.event === 'closed'));
      expect(received().slice(sent).map((request) => request.type)).toEqual(requests);
      const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> };
      expect(Object.values(kept.agents).filter((agent) => agent.status === 'running')).toEqual([]);
      expect(journalFiles()).toEqual([]);
    });

    it('refuses a plain prompt in a confined place, and a confined prompt in a worktree place', async () => {
      const runtime = start();
      await ready(runtime);
      const confinedPlace = await openedConfined(runtime);
      runtime.send(promptRequest(confinedPlace, 'op-0000000b'));
      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'unknown_handle' } });

      runtime.send({ type: 'open', op: 'op-0000000c', run: RUN, attempt: 'a4567cdef', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} } });
      const accepted = await runtime.next(isOp('op-0000000c', 'accepted'));
      runtime.send(confinedRequest('handle' in accepted ? String(accepted.handle) : '', 'op-0000000d'));
      expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'failed', failure: { code: 'unknown_handle' } });
      expect(received()).toEqual([]);
    });
  });

  describe('the daemon, as Paseo\'s own config names it', () => {
    /** Writes Paseo's config in `home`, as `paseo daemon config` keeps it, with the daemon listening at `listen`. */
    const paseoConfig = (home: string, listen: string): void => {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, daemon: { listen, relay: { enabled: false } } }));
    };

    it('connects to the daemon `daemon.listen` names in $PASEO_HOME/config.json when the definition sets no url, and a url set overrides it', async () => {
      // The fake offers Claude alone, so an init that reached any other daemon, such as one on Paseo's default port, differs.
      behave({ models: { claude: ['claude-opus-5-5'] } });
      const home = path.join(dir, 'paseo-home');
      paseoConfig(home, `127.0.0.1:${new URL(daemon.url).port}`);

      expect(await ready(start({ PASEO_HOME: home }), { options: {} })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude'] } });

      paseoConfig(home, '127.0.0.1:1');
      expect(await ready(start({ PASEO_HOME: home }), { options: { url: daemon.url } })).toMatchObject({ type: 'init', ok: true });
    });

    it('reads ~/.paseo/config.json when PASEO_HOME is unset, where a listen of a port alone is that port on 127.0.0.1', async () => {
      behave({ models: { claude: ['claude-opus-5-5'] } });
      paseoConfig(path.join(dir, 'home', '.paseo'), new URL(daemon.url).port);

      expect(await ready(start({ PASEO_HOME: undefined }), { options: {} })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude'] } });
    });

    it('reaches a daemon Paseo\'s config puts on a Unix socket, and takes it as one on this machine', async () => {
      await daemon.close();
      // A Unix socket's path is at most 104 bytes on macOS, which the test directory may pass.
      const sockets = fs.mkdtempSync(path.join('/tmp', 'tpaseo-'));
      onTestFinished(() => fs.rmSync(sockets, { recursive: true, force: true }));
      const socket = path.join(sockets, 'd.sock');
      daemon = await startFakeDaemon({ state: daemonState, port: 0, socket });
      behave({ codex_login: 'signed_in' });
      const home = path.join(dir, 'paseo-home');
      paseoConfig(home, socket);

      // Codex's sign-in is checked only on a daemon on this machine, which a Unix socket is.
      expect(await ready(start({ PASEO_HOME: home }), { options: {} })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'codex', 'opencode'] } });
    });

    it('fails init naming Paseo\'s config when it cannot read the daemon\'s address there, rather than guess one', async () => {
      const home = path.join(dir, 'paseo-home');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, 'config.json'), '{"daemon": {"listen": ');

      expect(await ready(start({ PASEO_HOME: home }), { options: {} })).toMatchObject({
        type: 'init', ok: false,
        error: { code: 'paseo_config', message: expect.stringContaining(`teamai-runtime-paseo could not read the Paseo daemon's address from ${path.join(home, 'config.json')}`) },
      });
    });
  });

  it('fails init, saying how to install Paseo or point at its client, when no Paseo client can be found', async () => {
    const empty = path.join(dir, 'no-client');
    fs.mkdirSync(empty);

    expect(await ready(start({ PASEO_CLIENT_PATH: empty }))).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'client_missing',
        message: `teamai-runtime-paseo found no Paseo client in ${empty}, which PASEO_CLIENT_PATH names. Install the Paseo CLI from the Paseo desktop app's settings, or with npm install -g @getpaseo/cli, or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.`,
      },
    });
    expect(await ready(start({ PASEO_CLIENT_PATH: undefined, PATH: path.dirname(process.execPath) }))).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'client_missing',
        message: 'teamai-runtime-paseo found no `paseo` on PATH, or in ~/.local/bin where the Paseo desktop app installs its CLI, to load the Paseo client from. Install the Paseo CLI from the Paseo desktop app\'s settings, or with npm install -g @getpaseo/cli, or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.',
      },
    });
  });

  it('fails init on a client older than the Paseo it runs against', async () => {
    const old = path.join(dir, 'old-client');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ name: '@getpaseo/client', version: '0.13.2' }));

    expect(await ready(start({ PASEO_CLIENT_PATH: old }))).toEqual({
      type: 'init', ok: false,
      error: { code: 'client_version', message: `The Paseo client in ${old} is version 0.13.2; teamai-runtime-paseo needs Paseo 0.14.0 or later. Update Paseo, or set PASEO_CLIENT_PATH to a newer @getpaseo/client package.` },
    });
  });

  it('runs on the client of the paseo on PATH, found through the links an install makes', async () => {
    // As npm installs it: bin/paseo links into the CLI package, whose node_modules holds the client.
    const cli = path.join(dir, 'lib', 'node_modules', '@getpaseo', 'cli');
    fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(cli, 'node_modules', '@getpaseo'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@getpaseo/cli', version: '0.14.0' }));
    fs.writeFileSync(path.join(cli, 'bin', 'paseo'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(TEST_CLIENT, path.join(cli, 'node_modules', '@getpaseo', 'client'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.symlinkSync(path.join(cli, 'bin', 'paseo'), path.join(dir, 'bin', 'paseo'));

    expect(await ready(start({ PASEO_CLIENT_PATH: undefined, PATH: [path.join(dir, 'bin'), path.dirname(process.execPath)].join(path.delimiter) }))).toMatchObject({ type: 'init', ok: true });
  });

  it('runs on the client inside the Paseo app, through the CLI its install-CLI action links into ~/.local/bin, though no paseo is on PATH', async () => {
    const cli = paseoApp(path.join(dir, 'app'), TEST_CLIENT);
    fs.mkdirSync(path.join(dir, 'home', '.local', 'bin'), { recursive: true });
    fs.symlinkSync(cli, path.join(dir, 'home', '.local', 'bin', 'paseo'));
    const env = { PASEO_CLIENT_PATH: undefined, PATH: path.dirname(process.execPath) };

    expect(await ready(start(env))).toMatchObject({ type: 'init', ok: true });
    // Once unpacked, the client is loaded again from where it was kept, as a second runtime does.
    expect(await ready(start(env))).toMatchObject({ type: 'init', ok: true });
  });

  it('fails init naming the file, rather than load it, when a file of the client in the Paseo app does not match the app\'s own hash', async () => {
    const cli = paseoApp(path.join(dir, 'app'), TEST_CLIENT, 'node_modules/ws/package.json');
    fs.mkdirSync(path.join(dir, 'home', '.local', 'bin'), { recursive: true });
    fs.symlinkSync(cli, path.join(dir, 'home', '.local', 'bin', 'paseo'));
    const app = fs.realpathSync(path.join(dir, 'app', 'Paseo.app'));

    expect(await ready(start({ PASEO_CLIENT_PATH: undefined, PATH: path.dirname(process.execPath) }))).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'client_missing',
        message: `teamai-runtime-paseo could not unpack the Paseo client from the Paseo app at ${app}: node_modules/ws/package.json does not match the SHA-256 the app records for it. Reinstall the Paseo app, or install the Paseo CLI (npm install -g @getpaseo/cli) so \`paseo\` is on PATH.`,
      },
    });
  });

  it('fails a step whose agent errors, with Paseo\'s error, and one whose agent wrote no result', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    behave({ error: 'Claude Code exited: not logged in' });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'The claude agent failed in Paseo: Claude Code exited: not logged in' } });

    behave({});
    runtime.send(promptRequest(handle, 'op-0000000c'));
    expect(await runtime.next(isEnd('op-0000000c'))).toEqual({ op: 'op-0000000c', event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  it('fails a step whose agent wrote its result but has no session in Paseo, saying so rather than blaming the result', async () => {
    behave({ output: { verdict: 'approve' }, no_session: true });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'tool_failed', message: 'Paseo reported no session for the claude agent, so teamai cannot record or score its pass. Run `teamai workflow retry` to run it again.' },
    });
  });
});
