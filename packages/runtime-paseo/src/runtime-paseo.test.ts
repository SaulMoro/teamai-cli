import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OpIdSchema, type InitInstance, type PromptLeaseSchema, type PromptRequestSchema, type RuntimeMessage, type RuntimeMode, type RuntimeOptions } from '@teamai/runtime-protocol';
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

async function ready(runtime: Runtime, { mode = 'unattended', options = { url: daemon.url }, instances }: { mode?: RuntimeMode; options?: RuntimeOptions; instances?: InitInstance[] } = {}): Promise<RuntimeMessage> {
  runtime.send({ type: 'init', protocol: 1, mode, options, ...(instances && { instances }) });

  return runtime.next(isInit);
}

const openRequest = (op: string, attempt: string, tool?: string) => ({
  type: 'open' as const, op, run: RUN, attempt, credentials: {}, ...(tool !== undefined && { tool }), view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} },
});

/** Opens the attempt's place and waits until it is ready, as teamai does before it sends a prompt there. */
async function opened(runtime: Runtime, { attempt = ATTEMPT, op = 'op-0000000a', tool }: { attempt?: string; op?: string; tool?: string } = {}): Promise<string> {
  runtime.send(openRequest(op, attempt, tool));
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
const mayStartMessage = (agentId: string): string => `Paseo does not show the claude agent ${agentId} yet, though its create was sent, so it may still start in the worktree. Once it appears, run teamai workflow cancel ${RUN} again, which stops it. If it never appears in Paseo, the create was refused: check that nothing of the attempt runs in the worktree, then run teamai workflow cancel ${RUN} --release ${ATTEMPT}.`;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Why init names a tool unavailable on the test daemon, as teamai shows it on a step that names that tool. */
const cannotRun = (tool: string, reason: string): string => `The Paseo daemon at ${daemon.url} cannot run ${tool}: ${reason}.`;

/** Why a tool the daemon has not installed is unavailable. */
const notInstalled = (tool: string): string => `it is not installed where the daemon finds its tools; install ${tool} on the daemon's PATH and sign in to it there`;

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

  it('offers neither a step nor a judge on a tool installed but signed out, which Paseo still calls available, and names it unavailable with how to sign it in', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] }, sign_in: { claude: 'signed_out' } });

    expect(await ready(start())).toMatchObject({
      ok: true, can: { tools: ['opencode'], confined: [{ tools: ['opencode'] }] },
      unavailable: { claude: cannotRun('claude', 'signed out; run `claude auth login` on the daemon\'s host'), codex: cannotRun('codex', notInstalled('codex')) },
    });
  });

  it('starts though the daemon can run none of the tools, so command steps still run elsewhere, naming each tool unavailable with what it lacks and how to sign it in', async () => {
    // OpenCode reaches no model provider: Paseo lists no model for it, though its own free models need no sign-in.
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'], opencode: [] }, sign_in: { claude: 'signed_out' }, codex_login: 'signed_out' });

    expect(await ready(start())).toEqual({
      type: 'init', ok: true, prompt: true,
      can: { exec: false, setup: false, hitl: false, unattended: false, env: false, tokens: false, max_turns: false, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], role: true, tools: [] },
      unavailable: {
        claude: cannotRun('claude', 'signed out; run `claude auth login` on the daemon\'s host'),
        codex: cannotRun('codex', 'signed out; run `codex login` on the daemon\'s host'),
        opencode: cannotRun('opencode', 'reaches no model provider; run `opencode auth login` on the daemon\'s host, then `paseo restart`'),
      },
    });
  });

  it('does not offer OpenCode where Paseo shares OpenCode\'s own background server, which takes no environment for an agent, and names the remedy', async () => {
    behave({ models: { opencode: ['opencode/beam-free'] }, opencode_server: 'http://127.0.0.1:49374' });

    expect(await ready(start())).toMatchObject({
      ok: true, can: { tools: [] },
      unavailable: {
        opencode: cannotRun('opencode', 'Paseo runs it on OpenCode\'s background server at http://127.0.0.1:49374, which takes no environment for an agent, and teamai gives each step TEAMAI_RUN_DIR; stop that server with `opencode service stop` on the daemon\'s host, then `paseo restart`'),
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
      ok: true, unavailable: { codex: expect.stringMatching(/ codex: `\/\S+\/host-bin\/codex login status` did not answer \(.+\); run it on the daemon's host to see why\.$/) },
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
      ok: true, unavailable: { codex: cannotRun('codex', `Paseo resolves it to "${resolved}", which is not an absolute path to a codex; run \`paseo provider diagnostic codex\` on the daemon's host to see why`) },
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

    expect(await ready(start())).toMatchObject({ ok: true, unavailable: { codex: expect.stringContaining('login status` did not answer') } });
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
      ok: true, unavailable: { codex: expect.stringMatching(/ codex: `\/\S+\/host-bin\/codex login status` gave no sign-in answer \(exit 2: error: unrecognized subcommand: status\); run it on the daemon's host to see why\.$/) },
    });
  });

  it('does not offer Codex on a daemon at an address that is not loopback, whose host teamai cannot ask, and says so', async () => {
    behave({ models: { codex: ['gpt-6.1-sol'] }, codex_login: 'signed_in' });
    // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
    const url = daemon.url.replace('127.0.0.1', '0.0.0.0');

    expect(await ready(start(), { options: { url } })).toMatchObject({
      ok: true, can: { tools: [] },
      unavailable: { codex: `The Paseo daemon at ${url} cannot run codex: teamai checks Codex's sign-in only on a daemon at a loopback address, and ${url} is not one.` },
    });
  });

  it('does not use a Claude whose sign-in Paseo does not report, and says so', async () => {
    behave({ models: { claude: ['claude-opus-5-5'] }, sign_in: { claude: 'unreported' } });

    expect(await ready(start())).toMatchObject({
      ok: true, unavailable: { claude: cannotRun('claude', 'Paseo does not report whether it is signed in; run `paseo provider diagnostic claude` on the daemon\'s host to see its Auth line') },
    });
  });

  it('starts though the daemon has none of the tools installed, naming each unavailable with how to install it', async () => {
    behave({ models: {} });

    expect(await ready(start())).toMatchObject({
      ok: true, can: { tools: [] },
      unavailable: { claude: cannotRun('claude', notInstalled('claude')), codex: cannotRun('codex', notInstalled('codex')), opencode: cannotRun('opencode', notInstalled('opencode')) },
    });
  });

  it('starts though Paseo fails one tool\'s diagnostic and another\'s modes listing, naming each of those unavailable with Paseo\'s error and still offering the rest', async () => {
    behave({ provider_errors: { claude: { request: 'diagnostic', error: 'claude auth status crashed' }, opencode: { request: 'modes', error: 'OpenCode SDK did not start' } } });

    expect(await ready(start())).toMatchObject({
      type: 'init', ok: true, can: { tools: [] },
      unavailable: {
        claude: cannotRun('claude', 'Paseo failed its diagnostic (claude auth status crashed); run `paseo provider diagnostic claude` on the daemon\'s host to see why'),
        opencode: cannotRun('opencode', 'Paseo failed to list its modes (OpenCode SDK did not start); run `paseo provider ls` on the daemon\'s host to see why'),
      },
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

  it('labels a step\'s agent with the Paseo agent the run was started from, and opens its prompt with a link to that agent', async () => {
    behave({ output: { verdict: 'approve' } });
    // The agent the member started the run from: one the same daemon runs.
    const first = start();
    await ready(first);
    first.send(promptRequest(await opened(first), 'op-0000000b'));
    await first.next(isEnd('op-0000000b'));
    const parent = agentIdOf(OpIdSchema.parse('op-0000000b'));

    const runtime = start({ PASEO_AGENT_ID: parent });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' }), 'op-0000000d'));
    await runtime.next(isEnd('op-0000000d'));

    const create = received().find((request) => request.type === 'agent.create.request' && request.idempotencyKey === 'op-0000000d');
    // `paseo ls --label teamai-parent=<agent>` lists the agents a run started from that agent made.
    expect(create?.labels).toEqual({ 'teamai-attempt': `${RUN}/a0123abce`, 'teamai-run': RUN, 'teamai-step': 'review', 'teamai-parent': parent });
    expect(String(create?.initialPrompt).split('\n\n')).toEqual([
      `This agent runs step "review" of teamai workflow run ${RUN}, started from the Paseo agent paseo://h/srv_fake0001/agent/${parent}.`,
      'Review the change.',
      `Write the workflow result as JSON to ${path.join(dir, 'out', 'result.json')}. Write {"output": …}.`,
    ]);
  });

  it('names a parent agent its daemon does not know by its id alone, with no link to a server that does not hold it', async () => {
    behave({ output: { verdict: 'approve' } });
    const runtime = start({ PASEO_AGENT_ID: 'agent-on-another-daemon' });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    const [create] = received();
    expect(create?.labels).toMatchObject({ 'teamai-parent': 'agent-on-another-daemon' });
    expect(String(create?.initialPrompt).split('\n\n')[0]).toBe(`This agent runs step "review" of teamai workflow run ${RUN}, started from the Paseo agent agent-on-another-daemon.`);
  });

  it('opens a step\'s prompt with teamai\'s prompt alone, and no parent label, when the run was not started from a Paseo agent', async () => {
    behave({ output: { verdict: 'approve' } });
    const runtime = start({ PASEO_AGENT_ID: undefined });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    const [create] = received();
    expect(create?.labels).not.toHaveProperty('teamai-parent');
    expect(String(create?.initialPrompt)).toMatch(/^Review the change\./);
  });

  it('names the Claude home the daemon keeps a step\'s session in, so teamai reads it there though it runs in another HOME', async () => {
    const elsewhere = path.join(dir, 'daemon-user', '.claude');
    behave({ output: { verdict: 'approve' }, claude_home: elsewhere });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'claude', home: elsewhere } });
  });

  it('names the Codex home that holds a step\'s session, found by its thread id, so teamai reads it there though it runs in another HOME, and none when no home it can see holds it', async () => {
    const elsewhere = path.join(dir, 'daemon-user', '.codex');
    behave({ output: { verdict: 'approve' }, codex_login: 'signed_in', codex_home: elsewhere });
    const runtime = start({ CODEX_HOME: elsewhere });
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex', id: `fake-session-${agentIdOf(OpIdSchema.parse('op-0000000b'))}`, home: elsewhere } });

    behave({ output: { verdict: 'approve' }, codex_login: 'signed_in', codex_home: path.join(dir, 'unseen', '.codex') });
    runtime.send(promptRequest(handle, 'op-0000000c', { tool: 'codex', model: undefined }));
    const unseen = await runtime.next(isEnd('op-0000000c'));

    expect(unseen).toMatchObject({ event: 'finished', session: { tool: 'codex' } });
    expect('session' in unseen && unseen.session).not.toHaveProperty('home');
  });

  it('names the data directory of the daemon\'s OpenCode as an OpenCode step\'s session home, so teamai reads it there though it runs in another HOME, and none on a daemon on another host', async () => {
    const elsewhere = path.join(dir, 'daemon-user', 'data');
    behave({ output: { verdict: 'approve' }, opencode_data_home: elsewhere });
    const runtime = start({ XDG_DATA_HOME: elsewhere });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'opencode', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode', home: elsewhere } });

    // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
    const remote = start({ XDG_DATA_HOME: elsewhere });
    await ready(remote, { options: { url: daemon.url.replace('127.0.0.1', '0.0.0.0') } });
    remote.send(promptRequest(await opened(remote, { attempt: 'a0123abce' }), 'op-0000000c', { tool: 'opencode', model: undefined }));
    const unseen = await remote.next(isEnd('op-0000000c'));

    expect(unseen).toMatchObject({ event: 'finished', session: { tool: 'opencode' } });
    expect('session' in unseen && unseen.session).not.toHaveProperty('home');
  });

  it('names as an OpenCode step\'s session home the data directory whose store the step wrote, over one that only held a store from before', async () => {
    // teamai's own OpenCode left a store in its data directory before the step; the daemon's OpenCode writes in $HOME's.
    const stale = path.join(dir, 'teamai-data');
    fs.mkdirSync(path.join(stale, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(stale, 'opencode', 'opencode.db'), '');
    fs.utimesSync(path.join(stale, 'opencode', 'opencode.db'), new Date('2026-01-01'), new Date('2026-01-01'));
    const written = path.join(dir, 'home', '.local', 'share');
    behave({ output: { verdict: 'approve' }, opencode_data_home: written });
    const runtime = start({ XDG_DATA_HOME: stale });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'opencode', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode', home: written } });
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

  it('says once at start, for each tool, that its steps start in a tighter mode than the bypass mode Paseo sets as its default', async () => {
    behave({ codex_login: 'signed_in', default_modes: { claude: 'bypassPermissions', codex: 'full-access' } });
    const runtime = start();

    expect(await ready(runtime)).toMatchObject({ ok: true });
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'notice')).toEqual([
      { event: 'notice', message: 'Paseo starts claude in mode bypassPermissions by default, which never asks before it acts; teamai starts its claude steps in mode auto, the nearest one before it in Paseo\'s list that asks.' },
      { event: 'notice', message: 'Paseo starts codex in mode full-access by default, which never asks before it acts; teamai starts its codex steps in mode auto-review, the nearest one before it in Paseo\'s list that asks.' },
    ]);
  });

  it('starts a tool in the bypass mode its mode option names, reporting that tool alone in permissions as full access and offering no unattended step', async () => {
    behave({ output: { ok: true }, codex_login: 'signed_in', default_modes: { codex: 'full-access' } });
    const runtime = start();

    expect(await ready(runtime, { options: { url: daemon.url, mode: { claude: 'bypassPermissions' } } })).toMatchObject({
      type: 'init', ok: true, permissions: { claude: 'full-access' }, can: { unattended: false, tools: ['claude', 'codex', 'opencode'] },
    });
    // Codex's default is still never inherited: only the option opts a tool in.
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'notice').map((line) => 'message' in line && line.message)).toEqual([
      'Paseo starts codex in mode full-access by default, which never asks before it acts; teamai starts its codex steps in mode auto-review, the nearest one before it in Paseo\'s list that asks.',
    ]);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(received().map((create) => create.config)).toEqual([expect.objectContaining({ provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions' })]);
  });

  it('starts a tool in a mode that asks when its mode option names one, over Paseo\'s default, and reports no permissions', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    const init = await ready(runtime, { options: { url: daemon.url, mode: { claude: 'plan' } } });

    expect(init).toMatchObject({ type: 'init', ok: true });
    expect(init).not.toHaveProperty('permissions');
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(received().map((create) => create.config)).toEqual([expect.objectContaining({ provider: 'claude', model: 'claude-opus-5-5', modeId: 'plan' })]);
  });

  it('does not offer a tool whose mode option names a mode Paseo does not list for it, saying which it lists', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] } });

    expect(await ready(start(), { options: { url: daemon.url, mode: { claude: 'yolo' } } })).toMatchObject({
      type: 'init', ok: true, can: { tools: ['opencode'] },
      unavailable: { claude: cannotRun('claude', 'the runtime\'s mode option names yolo for it, which Paseo does not list for claude (plan, default, acceptEdits, auto, bypassPermissions); name one of those') },
    });
  });

  describe('a team tool instance', () => {
    const ACME: InitInstance = { name: 'acme-claude', tool: 'claude', command: 'acme-claude', home: { dir: '.claude-acme', env: 'CLAUDE_CONFIG_DIR' } };

    it('runs a step on an instance through the Paseo custom provider whose command is the instance\'s, in its base tool\'s mode and grants, and names the instance as the session\'s tool', async () => {
      behave({ output: { ok: true }, custom_providers: { 'claude-acme': { extends: 'claude', command: ['/opt/acme/bin/acme-claude'] } } });
      const runtime = start();

      expect(await ready(runtime, { instances: [ACME, { name: 'acme-cursor', tool: 'cursor', command: 'acme-cursor' }] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-claude'] },
      });
      const handle = await opened(runtime);
      runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-claude' }, result: { output: { ok: true } } });
      expect(received()).toMatchObject([{
        config: { provider: 'claude-acme', model: 'claude-opus-5-5', modeId: 'auto', providerOptions: { allowedTools: [`Edit(/${path.join(dir, 'out', 'result.json')})`, `Edit(/${path.join(dir, 'run')}/**)`] } },
      }]);
    });

    it.each([
      ['no Paseo provider runs its command, and teamai finds no acme-claude on PATH to add one with', {}, {}, 'no Paseo provider runs its command acme-claude, and teamai adds one only for a command on its PATH; install acme-claude there, or name a Paseo provider that runs it in the runtime\'s providers option'],
      ['a Paseo provider of its name runs another command', { 'acme-claude': { extends: 'claude', command: ['claude'] } }, {}, 'no Paseo provider runs its command acme-claude, and the Paseo provider acme-claude runs claude instead, so teamai adds none under that name; point that provider at acme-claude, or name the provider to use in the runtime\'s providers option'],
      ['two Paseo providers run its command', { a: { extends: 'claude', command: ['acme-claude'] }, b: { extends: 'claude', command: ['/usr/local/bin/acme-claude'] } }, {}, 'Paseo providers a and b both run its command acme-claude; name the one to use in the runtime\'s providers option, such as providers: { acme-claude: a }'],
      ['the provider the providers option names does not extend its tool', { a: { extends: 'codex', command: ['acme-claude'] } }, { providers: { 'acme-claude': 'a' } }, 'the runtime\'s providers option names a, which the daemon\'s agents.providers does not hold as a provider that extends claude'],
      ['the provider the providers option names runs another command', { a: { extends: 'claude', command: ['claude'] } }, { providers: { 'acme-claude': 'a' } }, 'the runtime\'s providers option names a, which runs claude rather than its command acme-claude; name a provider whose command is acme-claude'],
    ] satisfies Array<[string, NonNullable<Behaviour['custom_providers']>, RuntimeOptions, string]>)('does not offer an instance when %s, naming how to set one up, and still offers the rest', async (_case, custom, options, reason) => {
      behave({ custom_providers: custom });

      expect(await ready(start(), { options: { url: daemon.url, ...options }, instances: [ACME] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] }, unavailable: { 'acme-claude': cannotRun('acme-claude', reason) },
      });
    });

    /** `name` as an executable on the runtime's PATH, as a member installs a team tool, and the env a runtime finds it with. */
    const installed = (name: string): { file: string; env: Record<string, string> } => {
      const bin = path.join(dir, 'bin');
      const file = path.join(bin, name);
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(file, '#!/bin/sh\nexec claude "$@"\n', { mode: 0o755 });

      return { file, env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, PASEO_HOME: path.join(dir, 'paseo') } };
    };

    const notices = (runtime: Runtime): RuntimeMessage[] => runtime.lines.filter((line) => 'event' in line && line.event === 'notice');

    const configChanges = (): unknown[] => received().filter((request) => request.type === 'set_daemon_config_request');

    /** The custom providers the daemon keeps now, by id. */
    const customProviders = (): Record<string, unknown> => (JSON.parse(fs.readFileSync(path.join(daemonState, 'behaviour.json'), 'utf8')) as { custom_providers?: Record<string, unknown> }).custom_providers ?? {};

    it('offers an instance no provider runs, adds a Paseo provider named after it at the first open that runs it, extending its tool and running its command from PATH in its own home, says so once, runs its steps there, and reuses it in a later run without adding it again', async () => {
      const { file, env } = installed('acme-claude');
      const home = path.join(dir, 'home', '.claude-acme');
      behave({ output: { ok: true } });
      const runtime = start(env);

      expect(await ready(runtime, { instances: [ACME] })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      expect(configChanges()).toEqual([]);
      const handle = await opened(runtime, { tool: 'acme-claude' });

      expect(notices(runtime)).toEqual([{
        event: 'notice', op: 'op-0000000a',
        message: `teamai added the Paseo provider acme-claude to the daemon at ${daemon.url} for its acme-claude steps: it extends claude and runs ${file}, with CLAUDE_CONFIG_DIR=${home}. It stays for later runs; to remove it, choose Remove provider on acme-claude in the Paseo app's provider settings, or delete agents.providers.acme-claude from ${path.join(dir, 'paseo', 'config.json')}, then run \`paseo daemon reload --home ${path.join(dir, 'paseo')}\`. Paseo cannot show its agents' logs once it is gone, so read them first.`,
      }]);
      runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-claude', home }, result: { output: { ok: true } } });
      expect(received()).toMatchObject([
        { type: 'set_daemon_config_request', config: { providers: { 'acme-claude': { extends: 'claude', label: 'acme-claude', command: [file], env: { CLAUDE_CONFIG_DIR: home } } } } },
        { type: 'agent.create.request', config: { provider: 'acme-claude', modeId: 'auto' } },
      ]);

      const later = start(env);

      expect(await ready(later, { mode: 'attended', instances: [ACME] })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      await opened(later, { attempt: 'a0123abce', tool: 'acme-claude' });
      expect(notices(later)).toEqual([]);
      expect(configChanges()).toHaveLength(1);
    });

    it('adds a provider once when two runtimes open the same instance together, setting no home for an instance with none of its own', async () => {
      const { file, env } = installed('acme-claude');
      const plain: InitInstance = { name: 'acme-claude', tool: 'claude', command: 'acme-claude' };
      behave({ config_ms: 500 });
      const [first, second] = [start(env), start(env)];

      for (const runtime of [first, second]) expect(await ready(runtime, { instances: [plain] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      first.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));
      second.send(openRequest('op-0000000c', 'a0123abce', 'acme-claude'));

      expect(await first.next(isOp('op-0000000a', 'ready'))).toMatchObject({ event: 'ready' });
      expect(await second.next(isOp('op-0000000c', 'ready'))).toMatchObject({ event: 'ready' });
      expect(configChanges()).toEqual([{ type: 'set_daemon_config_request', requestId: expect.any(String), config: { providers: { 'acme-claude': { extends: 'claude', label: 'acme-claude', command: [file] } } } }]);
      expect([...notices(first), ...notices(second)]).toHaveLength(1);
    });

    it('adds a provider once when another runtime opens an instance while this one adds two at once', async () => {
      const { file, env } = installed('acme-claude');
      installed('beta-claude');
      const acme: InitInstance = { name: 'acme-claude', tool: 'claude', command: 'acme-claude' };
      const beta: InitInstance = { name: 'beta-claude', tool: 'claude', command: 'beta-claude' };
      // acme-claude's add takes long; beta-claude's, which this runtime starts while it adds acme-claude, does not.
      behave({ provider_config_ms: { 'acme-claude': 1500 } });
      const [first, second] = [start(env), start(env)];

      for (const runtime of [first, second]) expect(await ready(runtime, { instances: [acme, beta] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'acme-claude', 'beta-claude'] } });
      first.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));
      await until(() => configChanges().length === 1);
      first.send(openRequest('op-0000000b', 'a0123abce', 'beta-claude'));
      await delay(200);
      second.send(openRequest('op-0000000c', 'a0123abcf', 'acme-claude'));

      for (const [runtime, op] of [[first, 'op-0000000a'], [first, 'op-0000000b'], [second, 'op-0000000c']] as const) expect(await runtime.next(isOp(op, 'ready'))).toMatchObject({ event: 'ready' });
      expect(configChanges()).toEqual([
        expect.objectContaining({ config: { providers: { 'acme-claude': { extends: 'claude', label: 'acme-claude', command: [file] } } } }),
        expect.objectContaining({ config: { providers: { 'beta-claude': { extends: 'claude', label: 'beta-claude', command: [path.join(dir, 'bin', 'beta-claude')] } } } }),
      ]);
      expect(notices(second)).toEqual([]);
    });

    it('adds a provider that runs its tool\'s own command in its own home for an instance with only a home of its own, and runs on one already there that does', async () => {
      const work: InitInstance = { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work', env: 'CLAUDE_CONFIG_DIR' } };
      const home = path.join(dir, 'home', '.claude-work');
      behave({ output: { ok: true } });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });

      expect(await ready(runtime, { instances: [work] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'claude-work'] } });
      runtime.send(promptRequest(await opened(runtime, { tool: 'claude-work' }), 'op-0000000b', { tool: 'claude-work' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'claude-work', home } });
      expect(received()).toMatchObject([
        { type: 'set_daemon_config_request', config: { providers: { 'claude-work': { extends: 'claude', label: 'claude-work', env: { CLAUDE_CONFIG_DIR: home } } } } },
        { type: 'agent.create.request', config: { provider: 'claude-work' } },
      ]);
      expect(notices(runtime)).toMatchObject([{ message: expect.stringContaining('it extends claude and runs claude\'s own command, with CLAUDE_CONFIG_DIR=') }]);

      behave({ output: { ok: true }, custom_providers: { work: { extends: 'claude', label: 'work', env: { CLAUDE_CONFIG_DIR: home } } } });
      const other = start();
      await ready(other, { instances: [work] });
      other.send(promptRequest(await opened(other, { attempt: 'a0123abce', op: 'op-0000000c', tool: 'claude-work' }), 'op-0000000d', { tool: 'claude-work' }));

      expect(await other.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished' });
      expect(received().at(-1)).toMatchObject({ type: 'agent.create.request', config: { provider: 'work' } });
      expect(configChanges()).toHaveLength(1);
    });

    // teamai resolves an instance's home once, the member's CLAUDE_CONFIG_DIR included, and the runtime uses it as given.
    it('adds the provider of an instance with only a home of its own in the home teamai resolved for it, wherever that is', async () => {
      const moved = path.join(dir, 'moved', 'claude-work-home');
      const work: InitInstance = { name: 'claude-work', tool: 'claude', home: { dir: moved, env: 'CLAUDE_CONFIG_DIR' } };
      behave({ output: { ok: true } });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });

      await ready(runtime, { instances: [work] });
      runtime.send(promptRequest(await opened(runtime, { tool: 'claude-work' }), 'op-0000000b', { tool: 'claude-work' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'claude-work', home: moved } });
      expect(configChanges()).toMatchObject([{ config: { providers: { 'claude-work': { extends: 'claude', env: { CLAUDE_CONFIG_DIR: moved } } } } }]);
      expect(notices(runtime)).toMatchObject([{ message: expect.stringContaining(`with CLAUDE_CONFIG_DIR=${moved}`) }]);
    });

    it('accepts a prompt on an instance no open added a provider for before it adds that provider, and runs the prompt on it', async () => {
      const { file, env } = installed('acme-claude');
      behave({ output: { ok: true }, config_ms: 500 });
      const runtime = start(env);

      await ready(runtime, { instances: [ACME] });
      runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-claude' } });
      expect(runtime.lines.flatMap((line) => ('event' in line && 'op' in line && line.op === 'op-0000000b' ? [line.event] : []))).toEqual(['accepted', 'notice', 'display', 'finished']);
      expect(received()).toMatchObject([
        { type: 'set_daemon_config_request', config: { providers: { 'acme-claude': { command: [file] } } } },
        { type: 'agent.create.request', config: { provider: 'acme-claude' } },
      ]);
    });

    it('fails the open of an instance whose added provider is signed out, naming its sign-in step, and removes the provider it added, which no agent ran on', async () => {
      const work: InitInstance = { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work', env: 'CLAUDE_CONFIG_DIR' } };
      behave({ sign_in: { 'claude-work': 'signed_out' } });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });
      await ready(runtime, { instances: [work] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'claude-work'));

      expect(await runtime.next(isEnd('op-0000000a'))).toEqual({
        op: 'op-0000000a', event: 'failed',
        failure: { code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run claude-work on the Paseo daemon at ${daemon.url}: signed out; run \`CLAUDE_CONFIG_DIR=~/.claude-work claude auth login\` on the daemon's host. Then run the step again.` },
      });
      expect(configChanges()).toEqual([
        expect.objectContaining({ config: { providers: { 'claude-work': expect.objectContaining({ extends: 'claude' }) } } }),
        expect.objectContaining({ config: { removeProviders: ['claude-work'] } }),
      ]);
      expect(customProviders()).not.toHaveProperty('claude-work');
      expect(notices(runtime)).toEqual([]);
    });

    it('says once that the provider it added stays, and how to remove it, when Paseo refuses to remove it again for an instance that cannot run on it', async () => {
      const work: InitInstance = { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work', env: 'CLAUDE_CONFIG_DIR' } };
      behave({ sign_in: { 'claude-work': 'signed_out' }, refuse_remove: 'The daemon config is read-only' });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });
      await ready(runtime, { instances: [work] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'claude-work'));

      expect(await runtime.next(isEnd('op-0000000a'))).toEqual({
        op: 'op-0000000a', event: 'failed',
        failure: { code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run claude-work on the Paseo daemon at ${daemon.url}: signed out; run \`CLAUDE_CONFIG_DIR=~/.claude-work claude auth login\` on the daemon's host. Paseo refused to remove the provider claude-work teamai added for it (Request failed: The daemon config is read-only), so it stays. Then run the step again.` },
      });
      expect(customProviders()).toHaveProperty('claude-work');
      expect(notices(runtime)).toMatchObject([{ op: 'op-0000000a', message: expect.stringContaining('teamai added the Paseo provider claude-work') }]);

      runtime.send(openRequest('op-0000000c', 'a0123abce', 'claude-work'));
      await runtime.next(isEnd('op-0000000c'));

      // The provider it kept is found again: nothing more is added or said.
      expect(configChanges().filter((change) => JSON.stringify(change).includes('"providers"'))).toHaveLength(1);
      expect(notices(runtime)).toHaveLength(1);
    });

    it('adds no provider on a daemon on another host, whose PATH teamai cannot see, and says how to add one there', async () => {
      const { env } = installed('acme-claude');
      // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
      const url = daemon.url.replace('127.0.0.1', '0.0.0.0');

      expect(await ready(start(env), { options: { url }, instances: [ACME] })).toMatchObject({
        type: 'init', ok: true,
        unavailable: { 'acme-claude': `The Paseo daemon at ${url} cannot run acme-claude: no Paseo provider runs its command acme-claude, and teamai adds one only on a daemon on this machine; add one on the daemon's host that extends claude with command ["acme-claude"] (\`paseo daemon config set agents.providers …\`, then \`paseo daemon reload\`), or name one in the runtime's providers option.` },
      });
    });

    it('adds no provider for an instance whose name Paseo takes for no provider, and says how to add one', async () => {
      const { env } = installed('acme.claude');

      expect(await ready(start(env), { instances: [{ ...ACME, name: 'acme.claude', command: 'acme.claude' }] })).toMatchObject({
        type: 'init', ok: true,
        unavailable: { 'acme.claude': cannotRun('acme.claude', 'no Paseo provider runs its command acme.claude, and teamai cannot add one named acme.claude, since Paseo names a provider with lowercase letters, digits and dashes only, starting with a letter; add one on the daemon\'s host that extends claude with command ["acme.claude"], and name it in the runtime\'s providers option') },
      });
    });

    it('ends a prompt cancelled at once, and closes its place, when the place closes while the prompt adds its instance\'s provider', async () => {
      const { env } = installed('acme-claude');
      behave({ output: { ok: true }, config_ms: 11000 });
      const runtime = start(env);
      await ready(runtime, { instances: [ACME] });
      const handle = await opened(runtime);
      runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'acme-claude' }));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      runtime.send({ type: 'close', handle });

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
      expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      expect(received().filter((request) => request.type === 'agent.create.request')).toEqual([]);
    });

    it('fails the open of an instance whose providers it cannot hold, naming the directory to make writable, and adds the provider at a later open once it can', async () => {
      const { file, env } = installed('acme-claude');
      const holds = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'providers');
      fs.mkdirSync(path.dirname(holds), { recursive: true });
      fs.writeFileSync(holds, 'not a directory');
      const runtime = start(env);
      await ready(runtime, { instances: [ACME] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));

      expect(await runtime.next(isEnd('op-0000000a'))).toMatchObject({ event: 'failed', failure: { code: 'tool_unavailable', message: expect.stringContaining('make that directory writable') } });

      fs.rmSync(holds);
      runtime.send(openRequest('op-0000000c', 'a0123abce', 'acme-claude'));

      expect(await runtime.next(isOp('op-0000000c', 'ready'))).toMatchObject({ event: 'ready' });
      expect(configChanges()).toMatchObject([{ config: { providers: { 'acme-claude': { command: [file] } } } }]);
    });

    it('fails the open of an instance whose provider Paseo refuses to add, naming Paseo\'s error and how to add one, and adds it at a later open once Paseo takes it', async () => {
      const { file, env } = installed('acme-claude');
      behave({ refuse_config: 'The daemon config is read-only' });
      const runtime = start(env);
      await ready(runtime, { instances: [ACME] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));

      expect(await runtime.next(isEnd('op-0000000a'))).toEqual({
        op: 'op-0000000a', event: 'failed',
        failure: { code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run acme-claude on the Paseo daemon at ${daemon.url}: Paseo refused the provider acme-claude teamai added for it (Request failed: The daemon config is read-only); add one on the daemon's host that extends claude with command ${JSON.stringify([file])}, or name one in the runtime's providers option. Then run the step again.` },
      });

      behave({});
      runtime.send(openRequest('op-0000000c', 'a0123abce', 'acme-claude'));

      expect(await runtime.next(isOp('op-0000000c', 'ready'))).toMatchObject({ event: 'ready' });
      // The refused change, then the one Paseo took.
      expect(configChanges()).toMatchObject([{ config: { providers: { 'acme-claude': { command: [file] } } } }, { config: { providers: { 'acme-claude': { command: [file] } } } }]);
      expect(notices(runtime)).toMatchObject([{ op: 'op-0000000c' }]);
    });

    it('still offers its tools when Paseo fails to read its config, naming each instance and named provider unavailable with Paseo\'s error', async () => {
      behave({ refuse_config_read: 'config.json is locked', custom_providers: { 'codex-wrap': { extends: 'codex', command: ['codex-wrap'] } } });
      const why = 'Paseo did not answer with its providers (config.json is locked); run `paseo daemon config get agents.providers --json` on the daemon\'s host to see why';

      expect(await ready(start(), { options: { url: daemon.url, providers: { codex: 'codex-wrap' } }, instances: [ACME] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] },
        unavailable: { 'acme-claude': cannotRun('acme-claude', why), codex: cannotRun('codex', why) },
      });
    });

    it('still offers its tools when the providers option names an instance teamai did not pass, naming it under unavailable', async () => {
      behave({ custom_providers: { 'claude-acme': { extends: 'claude', command: ['acme-claude'] } } });

      expect(await ready(start(), { options: { url: daemon.url, providers: { 'acme-claude': 'claude-acme', cursor: 'x' } } })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] },
        unavailable: {
          'acme-claude': cannotRun('acme-claude', 'the runtime\'s providers option names it, and teamai passed no tool instance acme-claude here; a team tool runs here once its command is accepted on this machine. If it is no team tool, remove acme-claude from the providers option'),
          cursor: cannotRun('cursor', 'the runtime\'s providers option names it, and teamai passed no tool instance cursor here; a team tool runs here once its command is accepted on this machine. If it is no team tool, remove cursor from the providers option'),
        },
      });
    });

    it('names an instance teamai passed whose tool Paseo does not run under unavailable, when the providers option names it', async () => {
      const codebuddy = { name: 'acme-codebuddy', tool: 'codebuddy', command: 'acme-codebuddy' };

      expect(await ready(start(), { options: { url: daemon.url, providers: { 'acme-codebuddy': 'x' } }, instances: [codebuddy] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] },
        unavailable: { 'acme-codebuddy': cannotRun('acme-codebuddy', 'it extends codebuddy, which Paseo does not run. Remove acme-codebuddy from the providers option') },
      });
    });

    it('runs an instance on the provider the providers option names, when two run its command', async () => {
      behave({ output: { ok: true }, custom_providers: { a: { extends: 'claude', command: ['acme-claude'] }, b: { extends: 'claude', command: ['acme-claude'] } } });
      const runtime = start();

      expect(await ready(runtime, { options: { url: daemon.url, providers: { 'acme-claude': 'b' } }, instances: [ACME] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
      expect(received()).toMatchObject([{ config: { provider: 'b' } }]);
    });
  });

  it('checks the sign-in of a Codex instance in the instance\'s own Codex home', async () => {
    const acme: InitInstance = { name: 'acme-codex', tool: 'codex', command: 'acme-codex', home: { dir: '.codex-acme', env: 'CODEX_HOME' } };
    behave({ codex_login: 'signed_in', codex_login_home: path.join(dir, 'home', '.codex-acme'), custom_providers: { 'codex-acme': { extends: 'codex', command: ['/opt/acme/bin/acme-codex'] } } });

    expect(await ready(start(), { instances: [acme] })).toMatchObject({
      type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-codex'] },
      unavailable: { codex: cannotRun('codex', 'signed out; run `codex login` on the daemon\'s host') },
    });
  });

  it('names the instance\'s own command and home in the sign-in step of an instance that is signed out', async () => {
    const acme: InitInstance = { name: 'acme-codex', tool: 'codex', command: 'acme-codex', home: { dir: '.codex-acme', env: 'CODEX_HOME' } };
    behave({ codex_login: 'signed_out', sign_in: { 'claude-acme': 'signed_out' }, custom_providers: { 'codex-acme': { extends: 'codex', command: ['/opt/acme/bin/acme-codex'] }, 'claude-acme': { extends: 'claude', command: ['acme-claude'] } } });

    expect(await ready(start(), { instances: [acme, { name: 'acme-claude', tool: 'claude', command: 'acme-claude' }] })).toMatchObject({
      unavailable: {
        'acme-codex': cannotRun('acme-codex', 'signed out; run `CODEX_HOME=~/.codex-acme acme-codex login` on the daemon\'s host'),
        'acme-claude': cannotRun('acme-claude', 'signed out; run `acme-claude auth login` on the daemon\'s host'),
      },
    });
  });

  it('checks a Codex instance\'s sign-in, and finds its sessions, in the home its Paseo provider sets in its env, saying once that this is not teamai\'s home for it', async () => {
    const providerHome = path.join(dir, 'paseo-homes', 'acme-codex');
    const acme: InitInstance = { name: 'acme-codex', tool: 'codex', command: 'acme-codex', home: { dir: '.codex-acme', env: 'CODEX_HOME' } };
    behave({
      output: { ok: true }, codex_login: 'signed_in', codex_login_home: providerHome, codex_home: providerHome,
      custom_providers: { 'codex-acme': { extends: 'codex', command: ['/opt/acme/bin/acme-codex'], env: { CODEX_HOME: providerHome, OPENAI_BASE_URL: 'https://llm.acme.example' } } },
    });
    const runtime = start();

    expect(await ready(runtime, { instances: [acme] })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-codex'] } });
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'notice')).toEqual([{
      event: 'notice',
      message: `Paseo provider codex-acme runs acme-codex with CODEX_HOME=${providerHome}, not teamai's home for it (${path.join(dir, 'home', '.codex-acme')}): its steps sign in and keep their sessions in ${providerHome}, where teamai reads them.`,
    }]);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'acme-codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-codex', home: providerHome } });
  });

  it('checks the sign-in of Codex on the custom provider the providers option names for it, through that provider\'s own command', async () => {
    behave({ codex_login: 'signed_in', custom_providers: { 'codex-wrap': { extends: 'codex', command: ['/opt/wrap/bin/codex-wrap'] } } });

    const init = await ready(start(), { options: { url: daemon.url, providers: { codex: 'codex-wrap' } } });

    expect(init).not.toHaveProperty('unavailable.codex');
    expect(init).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'codex', 'opencode'] } });
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

  it('answers a cancel of a prompt that already ended with that end again, and stops nothing', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out', output: { verdict: 'approve' } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const finished = await runtime.next(isEnd('op-0000000b'));
    // Refused before any agent existed: Codex is signed out.
    runtime.send(promptRequest(handle, 'op-0000000c', { tool: 'codex', model: undefined }));
    const refused = await runtime.next(isEnd('op-0000000c'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    runtime.send({ type: 'cancel', op: 'op-0000000c' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(finished);
    expect(await runtime.next(isEnd('op-0000000c'))).toEqual(refused);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);
  });

  it('answers a recover-mode cancel of a prompt whose end teamai lost with the end it recorded', async () => {
    behave({ output: { verdict: 'approve' } });
    const first = start();
    await ready(first);
    first.send(promptRequest(await opened(first), 'op-0000000b'));
    const finished = await first.next(isEnd('op-0000000b'));
    await first.kill();

    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual(finished);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);
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

  it('fails the attempt with its work kept when the daemon restarts mid-step, leaving the retry to teamai, and a retried prompt runs again', async () => {
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
      failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${daemon.url} stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree.` },
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

  it('answers a retried cancel with the end a runtime following the resent prompt recorded while Paseo answered the cancel', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    first.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await first.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    await first.kill();

    // Paseo takes the retried cancel but answers it late. The runtime the prompt is resent to cancels the agent too, is
    // answered at once, sees the agent stop and records the end before the runtime that retried the cancel hears back.
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_000, cancel_reply_ms: 4_000 });
    const second = start();
    await ready(second, { mode: 'recover' });
    second.send({ type: 'cancel', op: 'op-0000000b' });
    await expect.poll(() => received().filter((request) => request.type === 'cancel_agent_request')).toHaveLength(2);
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_000 });
    const restarted = start();
    await ready(restarted);
    restarted.send(promptRequest(handle, 'op-0000000b'));
    expect(await restarted.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });

    const answered = await Promise.race([second.next(isEnd('op-0000000b')), delay(6_000).then(() => 'no answer')]);

    expect(answered).toEqual({ op: 'op-0000000b', event: 'cancelled' });
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
        message: mayStartMessage(agentId),
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

  it('keeps an attempt whose refused create never starts its agent, naming how to release it, and closes it once its record is gone', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 60_000, refuse_create_early: 'Connection reset before the create was answered' });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    const isCloseAnswer = (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event);
    runtime.send({ type: 'close', handle });
    expect(await runtime.next(isCloseAnswer)).toEqual({ event: 'close_failed', handle, failure: { code: 'close_failed', message: mayStartMessage(agentIdOf(OpIdSchema.parse('op-0000000b'))) } });

    // A record gone, as a person removed it before releases existed, no longer keeps the attempt.
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

  it('answers a cancel of a prompt whose failure it could not record with that failure again, never cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, models_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.chmodSync(ops, 0o555);
    const failed = await runtime.next(isEnd('op-0000000b'));
    fs.chmodSync(ops, 0o755);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(failed).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(failed);
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
    ['while Paseo creates its agent', 'create', 0],
    ['while its agent waits on a permission nobody answered', 'display', 0],
    // The archive stops the agent at once, and Paseo shows that only 2.5 s later: the prompt's own wait, which looks at the
    // permission each second, sees the agent stop first.
    ['while its agent waits on a permission nobody answered, though Paseo is slow to show the agent stopped', 'display', 2_500],
  ] as const)('ends a prompt cancelled, once, before its place closes %s', async (_, reached, fetchMs) => {
    behave({ create_ms: 1_000, ask_permission: true, hold_ms: 60_000, archive_ms: 100 });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));

    if (reached === 'create') await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    else await runtime.next(isOp('op-0000000b', 'display'));

    behave({ create_ms: 1_000, ask_permission: true, hold_ms: 60_000, archive_ms: 100, fetch_ms: fetchMs });
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

  it('never archives its workspace once the member works there too, as when they open the same checkout in Paseo during a read-only step, and stops only its own agents', async () => {
    behave({ output: { ok: true }, member_joins: true });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toEqual([]);
    const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { title: string | null; status: string }> };
    expect(Object.values(kept.agents).filter((agent) => agent.title === 'member').map((agent) => agent.status)).toEqual(['idle']);
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

  it('archives a workspace two attempts shared once the last of them closes, though each ran an agent there', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const first = await opened(runtime);
    const second = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(first, 'op-0000000b'));
    runtime.send(promptRequest(second, 'op-0000000d'));
    await runtime.next(isEnd('op-0000000b'));
    await runtime.next(isEnd('op-0000000d'));

    for (const handle of [first, second]) {
      runtime.send({ type: 'close', handle });
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

  it('takes over the hold on a directory once it is a minute old, as one whose runtime hangs on a Paseo that never answers, or died with its pid in use since', async () => {
    behave({ output: { ok: true }, open_reply_ms: 60_000 });
    const stuck = start();
    const other = start();
    await ready(stuck);
    await ready(other);
    stuck.send(openRequest('op-0000000a', ATTEMPT));
    await stuck.next(isOp('op-0000000a', 'accepted'));
    await until(() => fs.existsSync(path.join(daemonState, 'agents.json')) && worktreeWorkspace() !== undefined);
    const holds = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'opening');
    const aMinuteAgo = new Date(Date.now() - 61_000);

    for (const name of fs.readdirSync(holds)) fs.utimesSync(path.join(holds, name), aMinuteAgo, aMinuteAgo);
    other.send(openRequest('op-0000000c', 'a4567cdef'));

    expect(await other.next((line) => isOp('op-0000000c', 'ready')(line) || isOp('op-0000000c', 'failed')(line))).toMatchObject({ event: 'ready' });
  });

  it('archives the workspace an open made after taking over the hold of one still waiting for Paseo, whichever closes last', async () => {
    behave({ output: { ok: true }, list_ms: 4_000 });
    const stuck = start();
    const other = start();
    await ready(stuck);
    await ready(other);
    const stuckOpen = opened(stuck);
    const holds = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'opening');
    await until(() => fs.existsSync(holds) && fs.readdirSync(holds).some((name) => !name.startsWith('.')));
    // Its question is with Paseo; the next one is answered at once.
    await delay(500);
    behave({ output: { ok: true } });
    const aMinuteAgo = new Date(Date.now() - 61_000);

    for (const name of fs.readdirSync(holds)) fs.utimesSync(path.join(holds, name), aMinuteAgo, aMinuteAgo);
    const taken = await opened(other, { attempt: 'a4567cdef', op: 'op-0000000c' });
    expect(other.lines.find(isOp('op-0000000c', 'ready'))).toBeDefined();
    const late = await stuckOpen;
    expect(stuck.lines.find(isOp('op-0000000a', 'ready'))).toBeDefined();
    const workspace = worktreeWorkspace();

    other.send({ type: 'close', handle: taken });
    expect(await other.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'closed' });
    stuck.send({ type: 'close', handle: late });
    expect(await stuck.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'closed' });

    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  });

  // Each case waits out the runtime's real 20 s limit on a question to Paseo, then opens again.
  it.each([
    ['whether a workspace is open on the worktree', { list_ms: 60_000 }, ''],
    ['the open of the worktree as a workspace', { open_ms: 60_000 }, '; if Paseo opens it later, archive that workspace in the Paseo app'],
  ] satisfies Array<[string, Behaviour, string]>)('fails an open whose question to Paseo, %s, gets no answer in 20 s, and lets the next open of the directory go on', async (_question, slow, later) => {
    behave(slow);
    const runtime = start();
    await ready(runtime);
    const asked = Date.now();
    runtime.send(openRequest('op-0000000a', ATTEMPT));

    expect(await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line))).toEqual({
      op: 'op-0000000a', event: 'failed',
      failure: { code: 'workspace_failed', message: `Paseo could not open the worktree as a workspace: no answer in 20 s; check that its daemon answers with \`paseo ls\`, then run the step again${later}` },
    });
    expect(Date.now() - asked).toBeLessThan(30_000);

    behave({});
    await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    expect(runtime.lines.find(isOp('op-0000000c', 'ready'))).toBeDefined();
  }, 60_000);

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

  it('archives the workspace a second attempt opened through a link to the checkout, which Paseo keeps apart from the member\'s that a first attempt found there', async () => {
    const link = path.join(dir, 'checkout-link');
    fs.symlinkSync(worktree, link);
    behave({ output: { ok: true }, member_workspaces: [worktree] });
    const runtime = start();
    await ready(runtime);
    await opened(runtime);
    const viaLink = openRequest('op-0000000c', 'a4567cdef');
    runtime.send({ ...viaLink, view: { ...viaLink.view, worktree: link } });
    const accepted = await runtime.next(isOp('op-0000000c', 'accepted'));
    const handle = 'handle' in accepted ? String(accepted.handle) : '';
    await runtime.next((line) => isOp('op-0000000c', 'ready')(line) || isOp('op-0000000c', 'failed')(line));
    const linked = (JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { workspaces: Record<string, string> }).workspaces[link];

    runtime.send({ type: 'close', handle });

    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(linked).toBeDefined();
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: linked }]);
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

  it('forgets an attempt the person released though its close fails, so the last other attempt on its workspace archives it', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const released = await opened(runtime);
    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    runtime.send(promptRequest(released, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'close', handle: released, release: true });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'close_failed', handle: released, failure: { code: 'close_failed' } });
    runtime.send({ type: 'reattach', handle: released });
    expect(await runtime.next((line) => 'event' in line && ['alive', 'gone'].includes(line.event))).toEqual({ event: 'gone', handle: released });

    behave({ output: { ok: true } });
    runtime.send({ type: 'close', handle: other });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: other });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
    expect(journalFiles()).toEqual([]);
  });

  // It waits out the close's real 10 s wait for the create, then the create Paseo finishes at 14 s.
  it('keeps forgetting an attempt released while Paseo still created its agent, once that create finishes', async () => {
    const runtime = start();
    await ready(runtime);
    const released = await opened(runtime);
    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 14_000 });
    runtime.send(promptRequest(released, 'op-0000000b'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);

    runtime.send({ type: 'close', handle: released, release: true });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toMatchObject({
      event: 'close_failed', handle: released, failure: { message: expect.stringMatching(/^Paseo did not finish creating an agent of /) },
    });
    // The create finishes, and the runtime has seen it land.
    await until(() => agentsOf().length === 1, 20_000);
    await delay(500);
    runtime.send({ type: 'reattach', handle: released });
    expect(await runtime.next((line) => 'event' in line && ['alive', 'gone'].includes(line.event))).toEqual({ event: 'gone', handle: released });

    behave({ output: { ok: true } });
    runtime.send({ type: 'close', handle: other });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: other });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
  }, 45_000);

  // It waits out the close's real 10 s wait for the open, then the open Paseo answers at 14 s.
  it('keeps forgetting an attempt released while Paseo still opened its worktree, once that open ends', async () => {
    const runtime = start();
    await ready(runtime);
    const other = await opened(runtime, { attempt: 'a4567cdef', op: 'op-0000000c' });
    const workspace = worktreeWorkspace();
    // Paseo answers the open after the close gave up waiting for it, and before the open's own question times out.
    behave({ open_ms: 14_000 });
    runtime.send(openRequest('op-0000000a', ATTEMPT));
    const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));
    const released = 'handle' in accepted ? String(accepted.handle) : '';

    runtime.send({ type: 'close', handle: released, release: true });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toMatchObject({ event: 'close_failed', handle: released });
    await runtime.next((line) => isOp('op-0000000a', 'ready')(line) || isOp('op-0000000a', 'failed')(line));

    behave({});
    runtime.send({ type: 'close', handle: other });
    expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle: other });
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toMatchObject([{ workspaceId: workspace }]);
    expect(journalFiles()).toEqual([]);
  }, 30_000);

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

  it('answers a recover-mode cancel that joined another cancel\'s connection by its own deadline, connecting again once that one gave up, so a daemon back by then is reached', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    first.send(promptRequest(handle, 'op-0000000c'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.next(isOp('op-0000000c', 'display'));
    await first.kill();
    const { url } = daemon;
    const port = Number(new URL(url).port);
    await daemon.close();
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    onTestFinished(() => {
      for (const socket of sockets) socket.destroy();
    });
    const recovering = start();
    await ready(recovering, { mode: 'recover', options: { url } });

    recovering.send({ type: 'cancel', op: 'op-0000000b' });
    await delay(4_000);
    recovering.send({ type: 'cancel', op: 'op-0000000c' });
    // The daemon is back, though the connection both cancels share still hangs on the host that never answered.
    silent.close();
    daemon = await startFakeDaemon({ state: daemonState, port });

    expect(await recovering.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    expect(await recovering.next(isEnd('op-0000000c'))).toEqual({ op: 'op-0000000c', event: 'cancelled' });
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
    ['a mode for a tool it does not run', { url: 'ws://127.0.0.1:1/ws', mode: { cursor: 'agent' } }, {}, { code: 'bad_option', key: 'mode' }],
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

    it('fails a judge whose daemon restarts before it replies daemon_restarted, leaving the retry to teamai', async () => {
      // An agent cut short by the restart has said nothing yet that parses as a reply.
      behave({ hold_ms: 60_000, reply: 'Reading the diff…' });
      const runtime = start();
      await ready(runtime, { mode: 'attended' });
      const handle = await openedConfined(runtime);
      await runtime.next(isOp('op-0000000a', 'ready'));
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      await expect.poll(() => received().length).toBe(1);

      const port = Number(new URL(daemon.url).port);
      await daemon.close();
      daemon = await startFakeDaemon({ state: daemonState, port });

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
        op: 'op-0000000b', event: 'failed',
        failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${daemon.url} stopped while the claude agent answered the confined prompt, before it replied.` },
      });
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
      ['a tool Paseo does not run', {}, { tool: 'codebuddy', model: undefined }, 'tool_unavailable', 'teamai-runtime-paseo runs a confined prompt on claude, codex, opencode or the team\'s instances of them, not codebuddy'],
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

    it('fails a judge whose agent replied that it hit its usage limit usage_limited, rather than blame its reply', async () => {
      behave({ reply: "You've hit your limit · resets 3pm (Europe/Madrid)" });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
        op: 'op-0000000b', event: 'failed', failure: { code: 'usage_limited', message: "The claude agent hit its usage limit in Paseo: You've hit your limit · resets 3pm (Europe/Madrid)" },
      });
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

  it.each([
    ['Claude', 'claude', "You've hit your limit · resets 3pm (Europe/Madrid)"],
    ['Codex', 'codex', "You've hit your usage limit. Upgrade to Pro or try again at 3:04 PM."],
    ['Claude, on its 5-hour limit,', 'claude', '5-hour limit reached ∙ resets 2pm'],
    ['Claude, on the API\'s rate limit,', 'claude', 'API Error: Request rejected (429) · This request would exceed your account\'s rate limit. Please try again later.'],
  ])('fails a step whose %s agent stops on its usage limit usage_limited, with the reset time the tool gave, whether Paseo reports it as an error or as its last message', async (_, tool, said) => {
    behave({ codex_login: 'signed_in' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    behave({ codex_login: 'signed_in', error: said });
    runtime.send(promptRequest(handle, 'op-0000000b', { tool, model: undefined }));
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'usage_limited', message: `The ${tool} agent hit its usage limit in Paseo: ${said}` } });

    behave({ codex_login: 'signed_in', reply: said });
    runtime.send(promptRequest(handle, 'op-0000000c', { tool, model: undefined }));
    expect(await runtime.next(isEnd('op-0000000c'))).toEqual({ op: 'op-0000000c', event: 'failed', failure: { code: 'usage_limited', message: `The ${tool} agent hit its usage limit in Paseo: ${said}` } });
  });

  it('fails tool_failed, not usage_limited, a step whose agent writes no result after a last message that only mentions a limit', async () => {
    behave({ reply: 'The handler now returns 429 when clients hit your rate limit.' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  it('fails tool_failed, not usage_limited, a step whose agent writes no result after a last message of its own that starts with a limit it hit elsewhere', async () => {
    behave({ reply: 'Rate limit reached on the GitHub API while listing the pull requests.\n\nI could not finish the review; run it again once the limit resets.' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
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
