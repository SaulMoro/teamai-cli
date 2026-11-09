import { z } from 'zod';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { claudeFake } from '@teamai/tool-claude/testing';
import { fakeAgent, type FakeAgent } from '@teamai/tool-testing/fake-agent';
import { launchEnv, sessionRun } from '../launch-context.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { checkoutRecordKey, type CheckoutRecord } from '../pull.js';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { type JsonValue, type LocalConfig, type TeamaiConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { createLocalToolAdapter, type LocalToolAdapter, type LocalToolResult, type LocalToolRun, type ToolSpawn } from '../workflow/steps/local-tool-adapter.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { type WorkflowRunRecord } from '../workflow/records.js';
import { readRun } from '../workflow/store.js';
import { cancelRun } from '../workflow/run-controls.js';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import type { DriverRuntimes } from '../workflow/drivers/local/local-driver.js';
import { knownSecrets } from '../env-resolution.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';
import { commitFile, fakeClaude, git, recordDelivery } from './helpers/delivered-checkout.js';
import { dirs, endRecord, fixture, memberAiTool, projectAiTool, toolPaths, workflowFixture } from './helpers/workflow-local-driver-fixture.js';

_setDriverPollMs(20);

const fakeAgents: FakeAgent[] = [];

afterEach(() => {
  const left = fakeAgents.splice(0).flatMap((agent) => agent.stopLeft());

  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

/** Claude as its recorded call prints it, in a `bin` beside `workspace`, keeping its sessions under a home of its own. */
function claudeBeside(workspace: string, options: Omit<Parameters<typeof fakeAgent>[1], 'bin'>): FakeAgent {
  vi.stubEnv('HOME', path.join(path.dirname(workspace), 'home'));
  const agent = fakeAgent(claudeFake, { bin: path.join(path.dirname(workspace), 'bin'), ...options });
  fakeAgents.push(agent);

  return agent;
}
describe('local workflow prompt driver', () => {
  it('runs a prompt with a private result path and stores metadata', async () => {
    const { config, workspace, runId } = await fixture();
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, value) => {
        input = value;
        return {
          started: true as const,
          exitCode: 0,
          output: { ok: true },
          model: 'claude-sonnet',
          session: 'session-1',
          tokens: { input: 3, output: 1 },
        };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(input?.prompt).toBe('Review this project.');
    expect(input?.resultPath.startsWith(`${workspace}${path.sep}`)).toBe(false);
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({
      steps: [{
        status: 'succeeded',
        tool: 'claude',
        model: 'claude-sonnet',
        session: 'session-1',
        tokens: { input: 3, output: 1 },
        outputs: { ok: true },
      }],
    });
  });

  it('records how long the tool ran and the cost it stated, and neither for a tool that never started', async () => {
    const ran = await fixture();
    const unstarted = await fixture();
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { started: true as const, exitCode: 0, output: { ok: true }, cost: { amount: 0.25, unit: 'USD' } };
    }) };

    await runLocalDriver(ran.config, ran.runId, ran.workspace, { adapter, toolPaths });
    await runLocalDriver(unstarted.config, unstarted.runId, unstarted.workspace, { adapter: createLocalToolAdapter(undefined, () => null), toolPaths });

    const stored = await readRun(ran.config, ran.runId);
    const step = typeof stored === 'object' && stored.steps[0]?.status === 'succeeded' ? stored.steps[0] : undefined;
    expect(step).toMatchObject({ cost: { amount: 0.25, unit: 'USD' }, durationMs: expect.any(Number) });
    expect(step?.durationMs).toBeGreaterThanOrEqual(50);
    const never = await readRun(unstarted.config, unstarted.runId);
    expect(typeof never === 'object' && never.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable' } });
    expect(typeof never === 'object' && never.steps[0]).not.toHaveProperty('durationMs');
  });

  it.each([
    [{}, 'attended'],
    [{ CI: '1' }, 'unattended'],
  ])('launches the tool with the run mode of the process that drives the run: %o gives %s', async (env, mode) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(input?.env?.TEAMAI_MODE).toBe(mode);
    // What the launched session's hook records (#1384), and the pass's own record of the mode it ran in.
    expect(sessionRun({ ...input?.env, ...(input?.launch ? launchEnv(input.launch) : {}) })).toEqual({ runMode: mode, launchedBy: 'workflow' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ runMode: mode }] });
  });

  it.each<{ case: string; flags: Record<string, string>; configured: Record<string, string>; env: string; project?: string; machine?: string; ran: string }>([
    { case: 'TEAMAI_AI_TOOL over workflows.tools.default', flags: {}, configured: { default: 'claude' }, env: 'codex', ran: 'codex' },
    { case: '--tools over TEAMAI_AI_TOOL', flags: { default: 'claude' }, configured: {}, env: 'codex', ran: 'claude' },
    { case: "workflows.tools.default over the project's ai.tool", flags: {}, configured: { default: 'codex' }, env: '', project: 'opencode', machine: 'claude', ran: 'codex' },
    { case: "the project's ai.tool over the machine's", flags: {}, configured: {}, env: '', project: 'codex', machine: 'opencode', ran: 'codex' },
    { case: "the machine's ai.tool when nothing else names a tool", flags: {}, configured: {}, env: '', machine: 'opencode', ran: 'opencode' },
    { case: "the machine's ai.tool when the project's names a tool without workflow steps", flags: {}, configured: {}, env: '', project: 'pi', machine: 'opencode', ran: 'opencode' },
    { case: 'the next rung when TEAMAI_AI_TOOL names a tool without workflow steps', flags: {}, configured: { default: 'claude' }, env: 'openclaw', ran: 'claude' },
  ])('runs a prompt step on $case', async ({ flags, configured, env, project, machine, ran }) => {
    vi.stubEnv('TEAMAI_AI_TOOL', env);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: configured };
    if (project) projectAiTool(config, project);
    if (machine) memberAiTool(machine);
    const tools: string[] = [];
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async (tool: string) => { tools.push(tool); return { started: true as const, exitCode: 0 }; }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: flags });

    expect(tools).toEqual([ran]);
  });

  it('runs a prompt step on the tool it names, over --tools, workflows.tools and TEAMAI_AI_TOOL', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', 'opencode');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
    tool: claude
`);
    onTestFinished(fakeClaude(path.dirname(workspace), '2.1.301'));
    config.workflows = { tools: { default: 'codex' } };
    const tools: string[] = [];
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async (tool: string) => { tools.push(tool); return { started: true as const, exitCode: 0 }; }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths, tools: { default: 'codex' } });

    expect(tools).toEqual(['claude']);
  });

  it("fails a prompt step when the project's ai.tool names a tool teamai does not launch, naming its file", async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', '');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: {} };
    const file = projectAiTool(config, 'gemini');
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unsupported', message: expect.stringContaining(`ai.tool in the workspace config ${file} is "gemini", which is not a tool teamai launches.`) } }],
    });
  });

  it('fails a prompt step when TEAMAI_AI_TOOL names a tool teamai does not launch', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', 'gemini');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { config, workspace, runId } = await fixture();
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unsupported', message: expect.stringContaining('TEAMAI_AI_TOOL is "gemini", which is not a tool teamai launches.') } }],
    });
  });

  it('fails without a configured tool and does not invoke the adapter', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = undefined;
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'tool_unconfigured' } }],
    });
  });

  it('fails before spawn when a deployed agent is missing', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ failure: { code: 'agent_unavailable', message: expect.stringContaining('teamai pull') } }],
    });
  });

  it('loads a deployed agent and keeps its raw model without aliases', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    config.workflows = { tools: { default: 'opencode', reviewer: 'claude' } };
    const agents = path.join(workspace, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.md'), `---
name: reviewer
description: Reviews changes.
model: gateway-model
---
Follow the review checklist.
`);
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(adapter.run).toHaveBeenCalledWith('claude', expect.anything(), expect.any(AbortSignal));
    expect(input?.agent).toMatchObject({
      name: 'reviewer',
      instructions: 'Follow the review checklist.',
      model: 'gateway-model',
    });
    // The file's model is what the launch asked for, not what the tool reported (#1176).
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ steps: [{ status: 'succeeded', tool: 'claude' }] });
    expect(typeof stored === 'object' && stored.steps[0]).toEqual(expect.not.objectContaining({ model: expect.anything() }));
  });

  it('loads a user-scope agent from the home directory pull writes', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-home-'));
    dirs.push(home);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    config.scope = 'user';
    delete config.projectRoot;
    const agents = path.join(home, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.md'), `---
name: reviewer
description: Reviews changes.
model: claude-sonnet
---
Follow the review checklist.
`);
    const decoy = path.join(workspace, '.claude', 'agents');
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, 'reviewer.md'), `---
name: reviewer
description: Wrong copy.
model: wrong-model
---
Do not use this copy.
`);
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    try {
      await runLocalDriver(config, runId, workspace, { adapter, toolPaths });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    expect(input?.agent).toMatchObject({
      instructions: 'Follow the review checklist.',
      model: 'claude-sonnet',
    });
  });

  it('keeps repository changes and reports read_only_dirty', async () => {
    const { config, workspace, runId } = await fixture();
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        fs.writeFileSync(path.join(workspace, 'left-behind.txt'), 'inspect me\n');
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(fs.existsSync(path.join(workspace, 'left-behind.txt'))).toBe(true);
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('left-behind.txt') } }],
    });
  });

  it('fails when a prompt step edits a file that was already dirty', async () => {
    const { config, workspace, runId } = await fixture();
    const tracked = path.join(workspace, 'tracked.txt');
    fs.writeFileSync(tracked, 'already dirty\n');
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        fs.writeFileSync(tracked, 'changed again\n');
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(fs.readFileSync(tracked, 'utf8')).toBe('changed again\n');
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('tracked.txt') } }],
    });
  });

  it.each(['edit', 'add', 'remove'] as const)('detects a file change (%s) inside an existing untracked directory', async (change) => {
    const { config, workspace, runId } = await fixture();
    const directory = path.join(workspace, 'notes');
    fs.mkdirSync(directory);
    const existing = path.join(directory, 'draft.txt');
    fs.writeFileSync(existing, 'before\n');
    fs.writeFileSync(path.join(directory, 'keep.txt'), 'unchanged\n');
    const changed = change === 'add' ? path.join(directory, 'new.txt') : existing;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        if (change === 'remove') fs.rmSync(changed);
        else fs.writeFileSync(changed, 'after\n');
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining(`notes/${path.basename(changed)}`) } }],
    });
    if (change === 'remove') expect(fs.existsSync(changed)).toBe(false);
    else expect(fs.readFileSync(changed, 'utf8')).toBe('after\n');
  });

  it('allows an unchanged untracked directory', async () => {
    const { config, workspace, runId } = await fixture();
    fs.mkdirSync(path.join(workspace, 'notes'));
    fs.writeFileSync(path.join(workspace, 'notes', 'draft.txt'), 'before\n');
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })),
    };

    expect(await runLocalDriver(config, runId, workspace, { adapter, toolPaths }))
      .toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('detects when a tool removes a path that was dirty before the step', async () => {
    const { config, workspace, runId } = await fixture();
    const dirty = path.join(workspace, 'dirty-before.txt');
    fs.writeFileSync(dirty, 'remove me\n');
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        fs.rmSync(dirty);
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'read_only_dirty', message: expect.stringContaining('dirty-before.txt') } }],
    });
  });

  it.each(['codex-internal', 'tcodex'] as const)('loads a named %s agent with the Codex reader', async (tool) => {
    const { config, workspace, runId } = await fixture('reviewer');
    config.workflows = { tools: { reviewer: tool } };
    const agentsDir = tool === 'tcodex' ? '.tcodex/agents' : '.codex-internal/agents';
    const agents = path.join(workspace, agentsDir);
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.toml'), `name = "reviewer"
description = "Reviews changes."
developer_instructions = "Implement the change."
model = "gpt-5.4"
`);
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_selected, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, [tool]: { agents: agentsDir } } as TeamaiConfig['toolPaths'],
    });

    expect(adapter.run).toHaveBeenCalledWith(tool, expect.anything(), expect.any(AbortSignal));
    expect(input?.agent).toMatchObject({
      instructions: 'Implement the change.',
      model: 'gpt-5.4',
    });
  });

  it('launches a step after a from step on the tool its agent maps to, as it did before teamai checked that tool', async () => {
    const definition = { schemaVersion: 'v1alpha1', name: 'generated', description: 'Say hello.', steps: [{ id: 'hello', command: 'true' }] };
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Run what plan brings, then review.
steps:
  - id: plan
    command: printf '%s' '${JSON.stringify({ definition: { definition }, plan: {} })}'
    output: { definition: workflow, plan: json }
  - id: work
    needs: [plan]
    workflow: { from: plan }
  - id: review
    needs: [work]
    prompt: Review this project.
    agent: reviewer
    output:
      ok: boolean
`);
    config.workflows = { tools: { reviewer: 'codex-internal' } };
    const agents = path.join(workspace, '.codex-internal/agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.toml'), 'name = "reviewer"\ndescription = "Reviews changes."\ndeveloper_instructions = "Review the change."\n');
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })),
    };

    const ran = await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, 'codex-internal': { agents: '.codex-internal/agents' } } as TeamaiConfig['toolPaths'],
    });

    expect(ran).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(adapter.run).toHaveBeenCalledWith('codex-internal', expect.anything(), expect.any(AbortSignal));
  });

  it('loads a user-scope OpenCode agent from the home XDG_CONFIG_HOME moves', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    const xdg = path.join(path.dirname(workspace), 'xdg');
    vi.stubEnv('HOME', path.join(path.dirname(workspace), 'home'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    fs.mkdirSync(path.join(xdg, 'opencode', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'opencode', 'agents', 'reviewer.md'), '---\ndescription: Reviews changes.\nmode: subagent\n---\n\nReview the change.\n');
    const userConfig: LocalConfig = { ...config, scope: 'user', workflows: { tools: { reviewer: 'opencode' } } };
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_selected, value) => {
        input = value;
        return { started: true as const, exitCode: 0, output: { ok: true } };
      }),
    };

    try {
      await runLocalDriver(userConfig, runId, workspace, {
        adapter,
        toolPaths: { opencode: { agents: '.opencode/agents', userScope: { agents: '.config/opencode/agents' } } } as TeamaiConfig['toolPaths'],
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(await readRun(userConfig, runId)).toMatchObject({ steps: [{ status: 'succeeded' }] });
    expect(input?.agent).toMatchObject({ instructions: 'Review the change.' });
  });

  it('warns when codex exec cannot apply the deployed agent settings, and still runs the step', async () => {
    const { config, workspace, runId } = await fixture('reviewer');
    config.workflows = { tools: { reviewer: 'codex' } };
    const agents = path.join(workspace, '.codex', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'reviewer.toml'), `name = "reviewer"
description = "Reviews changes."
developer_instructions = "Read only."
sandbox_mode = "read-only"
`);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({ started: true as const, exitCode: 0, output: { ok: true } })),
    };

    await runLocalDriver(config, runId, workspace, {
      adapter,
      toolPaths: { ...toolPaths, codex: { agents: '.codex/agents' } } as TeamaiConfig['toolPaths'],
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sandbox_mode'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not blocked'));
    expect(adapter.run).toHaveBeenCalledWith('codex', expect.anything(), expect.any(AbortSignal));
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ status: 'succeeded' }] });
  });

  it('stores a structured child failure', async () => {
    const { config, workspace, runId } = await fixture();
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => ({
        started: true as const,
        exitCode: 1,
        failure: { code: 'tool_failed', message: 'claude exited with status 1' },
      })),
    };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ status: 'failed', failure: { code: 'tool_failed' } }],
    });
  });

  it('publishes the failure code it sets when the tool is not on PATH', async () => {
    const { config, workspace, runId } = await fixture();

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => null), toolPaths });

    expect(await endRecord(config)).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable' } });
  });

  it('stops a Claude prompt step that prints nothing for workflows.idle_timeout, and fails it naming the limit', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: { default: 'claude' }, idle_timeout: '1s' };
    const claude = claudeBeside(workspace, { always: ['hang'] });
    const started = Date.now();

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => claude.executable), toolPaths });

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'review', status: 'failed', failure: { code: 'tool_failed', message: 'claude printed nothing for 1s, longer than its idle limit (workflows.idle_timeout). Raise the limit if this tool works silently for longer.' } }],
    });
  });

  it('keeps a Claude prompt step that streams for longer than the idle limit but never stays silent that long', async () => {
    const { config, workspace, runId } = await fixture();
    // The fake prints three lines, each after a pause of half the limit: it streams for one and a half limits, and a
    // pause would have to double under load before the limit stops it.
    const idleMs = 2000;
    config.workflows = { tools: { default: 'claude' }, idle_timeout: `${idleMs / 1000}s` };
    const claude = claudeBeside(workspace, { answer: '{"ok":true}', always: ['slow'], slowMs: idleMs / 2 });

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => claude.executable), toolPaths });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'review', status: 'succeeded', outputs: { ok: true } }] });
  });

  it('refuses an idle limit that is no duration before it launches the prompt step\'s tool, naming the setting to fix', async () => {
    const { config, workspace, runId } = await fixture();
    config.workflows = { tools: { default: 'claude' }, idle_timeout: 'soon' };
    const claude = claudeBeside(workspace, { answer: '{"ok":true}' });

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => claude.executable), toolPaths });

    expect(claude.calls()).toEqual([]);
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'review', status: 'failed', failure: { code: 'tool_unconfigured', message: 'workflows.idle_timeout is "soon", which is no duration. Set it to one, such as 2m, or remove it.' } }],
    });
  });

  it('publishes no failure code the tool wrote into its result', async () => {
    const { config, workspace, runId } = await fixture();
    const claude = claudeBeside(workspace, {
      before: 'fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ failure: { code: "secret-x", message: "secret-x happened" } }));',
    });

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => claude.executable), toolPaths });

    expect(await readRun(config, runId)).toMatchObject({ steps: [{ status: 'failed', failure: { code: 'secret-x' } }] });
    const record = await endRecord(config);
    expect(record).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(record)).not.toContain('secret-x');
  });
});

describe('the agent a local pass ran as (#1176)', () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  type Observed = Awaited<ReturnType<typeof workflowFixture>> & { rev: string; skill: string; agentFile: string };

  /** The reviewer agent as pull deploys it for each tool, and the model it resolved to. */
  const reviewer = {
    claude: {
      file: '.claude/agents/reviewer.md',
      content: '---\nname: reviewer\ndescription: Reviews changes.\nmodel: claude-opus-4-1\n---\nFollow the review checklist.\n',
      model: 'claude-opus-4-1',
    },
    codex: {
      file: '.codex/agents/reviewer.toml',
      content: 'name = "reviewer"\ndescription = "Reviews changes."\ndeveloper_instructions = "Follow the review checklist."\nmodel = "gpt-5.4"\n',
      model: 'gpt-5.4',
    },
    opencode: {
      file: '.opencode/agents/reviewer.md',
      content: '---\ndescription: Reviews changes.\nmode: subagent\nmodel: anthropic/claude-sonnet-4-5\nvariant: high\n---\nFollow the review checklist.\n',
      model: 'anthropic/claude-sonnet-4-5',
    },
  } as const;

  /**
   * A run whose checkout a pull of the team clone's head delivered a skill and the reviewer agent into, with a fake
   * `claude --version` on PATH. `record` overrides fields of that pull's record.
   */
  async function observed(yaml: string, { tool = 'claude', record = {} }: { tool?: keyof typeof reviewer; record?: Partial<CheckoutRecord> } = {}): Promise<Observed> {
    const wf = await workflowFixture(yaml);
    const team = wf.config.repo.localPath;
    git(team, 'init', '-q');
    const rev = commitFile(team, 'agents/reviewer.yaml');
    const skill = path.join(wf.workspace, '.claude', 'skills', 'review', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, 'Review carefully.\n');
    const agentFile = path.join(wf.workspace, reviewer[tool].file);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, reviewer[tool].content);
    wf.config.workflows = { tools: { default: tool } };
    await recordDelivery(wf.config, {
      rev: rev.slice(0, 7),
      targets: [tool],
      files: [skill, agentFile],
      agentModels: { reviewer: { [tool]: { step: 'spec', model: reviewer[tool].model } } },
      ...record,
    });
    restore.push(fakeClaude(path.dirname(wf.workspace), '2.1.301'));
    return { ...wf, rev, skill, agentFile };
  }

  const reviewStep = (agent?: string) => `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt: Review this project.
${agent ? `    agent: ${agent}\n` : ''}`;

  const reports = (result: Partial<Extract<LocalToolResult, { started: true }>> = {}): LocalToolAdapter => ({
    runInteractive: vi.fn(),
    run: vi.fn(async () => ({ started: true as const, exitCode: 0, ...result })),
  });
  const codexToolPaths = { codex: { agents: '.codex/agents' } } satisfies TeamaiConfig['toolPaths'];

  async function entry(config: LocalConfig): Promise<NonNullable<WorkflowRunRecord['steps']>[number] | undefined> {
    return (await endRecord(config))?.steps?.[0];
  }

  it('publishes the definition, tool version, team commit and requested model of a Claude pass', async () => {
    const { config, workspace, runId, rev } = await observed(reviewStep('reviewer'));

    await runLocalDriver(config, runId, workspace, { adapter: reports({ model: 'claude-opus-4-1-20250805', applied: 'main' }), toolPaths });

    expect(await entry(config)).toMatchObject({
      tool: 'claude',
      model: 'claude-opus-4-1-20250805',
      agent: {
        v: 1,
        definition: { name: 'reviewer', applied: 'main' },
        tool: { name: 'claude', version: '2.1.301' },
        model: { requested: 'claude-opus-4-1', reported: 'claude-opus-4-1-20250805' },
        team: { revision: rev, localChanges: false },
        project: { commit: git(workspace, 'rev-parse', 'HEAD'), dirty: false },
        driver: 'local',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  describe('the team skills a pass used', () => {
    const SESSION = 'b0d5e000-0000-4000-8000-0000000000d1';
    const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
    const skillCall = (uuid: string, skill: string, sidechain = false, timestamp = new Date().toISOString()): string => line({
      type: 'assistant', uuid, parentUuid: 'u1', sessionId: SESSION, timestamp, ...(sidechain ? { isSidechain: true } : {}),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name: 'Skill', input: { skill } }] },
    });

    /**
     * A Claude pass that runs `during`, then writes a session whose main thread loads `main` and whose subagent loads
     * `subagent` through the skill tool, after a pass before it that loaded `earlier` when the pass resumes one.
     */
    const loading = (workspace: string, { main, subagent, earlier }: { main: string; subagent: string; earlier?: string }, during = () => {}): LocalToolAdapter => ({
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        during();
        const project = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(workspace));
        const subagents = path.join(project, SESSION, 'subagents');
        fs.mkdirSync(subagents, { recursive: true });
        const before = new Date(Date.now() - 3_600_000).toISOString();
        fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), (earlier ? skillCall('m0', earlier, false, before) : '') + line({
          type: 'user', uuid: 'u1', parentUuid: null, cwd: workspace, sessionId: SESSION, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Review this project.' },
        }) + skillCall('m1', main));
        fs.writeFileSync(path.join(subagents, 'agent-a.meta.json'), JSON.stringify({ toolUseId: 'toolu_m1', spawnDepth: 1 }));
        fs.writeFileSync(path.join(subagents, 'agent-a.jsonl'), skillCall('s1', subagent, true));
        return { started: true as const, exitCode: 0, session: SESSION };
      }),
    });

    async function usedOf(config: LocalConfig, runId: string): Promise<unknown> {
      const run = await readRun(config, runId);
      if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
      const [step] = run.steps;
      return step && 'used' in step ? step.used : 'absent';
    }

    it('records a team skill its subagent loaded that the checkout held as delivered at launch, and not the member\'s own skill', async () => {
      const { config, workspace, runId } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');
      fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'mine'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'mine', 'SKILL.md'), 'Mine.\n');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'mine', subagent: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: ['review'] });
    });

    it('still records a team skill that a pull removed while the pass ran', async () => {
      const { config, workspace, runId, skill } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');
      const pulled = () => {
        fs.rmSync(path.join(config.repo.localPath, 'skills'), { recursive: true });
        fs.rmSync(path.dirname(skill), { recursive: true });
      };

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'review', subagent: 'review' }, pulled), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: ['review'] });
    });

    it('records no skill whose copy in the checkout is not the one teamai delivered, though the team has one of its name', async () => {
      const { config, workspace, runId, skill } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');
      fs.writeFileSync(skill, 'Review my way.\n');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'review', subagent: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: [] });
    });

    it('records no skill that only a pass before it loaded in the session this pass resumes', async () => {
      const { config, workspace, runId } = await observed(reviewStep());
      commitFile(config.repo.localPath, 'skills/review/SKILL.md');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'mine', subagent: 'mine', earlier: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toEqual({ skills: [] });
    });

    it('records nothing for a checkout no pull delivered to', async () => {
      const { config, workspace, runId } = await workflowFixture(reviewStep());
      fs.mkdirSync(path.join(config.repo.localPath, 'skills', 'review'), { recursive: true });
      fs.writeFileSync(path.join(config.repo.localPath, 'skills', 'review', 'SKILL.md'), 'Review carefully.\n');

      await runLocalDriver(config, runId, workspace, { adapter: loading(workspace, { main: 'review', subagent: 'review' }), toolPaths });

      expect(await usedOf(config, runId)).toBe('absent');
    });
  });

  it('launches the tool bound to its checkout, so its session-start hook keeps the delivery', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => {
      input = value;
      return { started: true as const, exitCode: 0 };
    }) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(input?.launch).toEqual({ by: 'workflow', tool: 'claude', checkout: await checkoutRecordKey(config) });
  });

  it('publishes the --model a Codex launch passed as the requested model', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'), { tool: 'codex' });
    let argv: string[] = [];
    const codex: ToolSpawn = (_command, args, options) => {
      argv = args;
      return spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, "{}")'], options);
    };

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(codex, () => process.execPath), toolPaths: codexToolPaths });

    expect(argv).toEqual(expect.arrayContaining(['--model', 'gpt-5.4']));
    expect((await entry(config))?.agent).toMatchObject({
      definition: { name: 'reviewer', applied: 'prompt' },
      tool: { name: 'codex' },
      model: { requested: argv[argv.indexOf('--model') + 1] },
    });
  });

  it('publishes an OpenCode pass with the handoff its launch used and the model and variant of its file it passed', async () => {
    const opencodeToolPaths = { opencode: { agents: '.opencode/agents' } } satisfies TeamaiConfig['toolPaths'];
    const agentModels = { reviewer: { opencode: { step: 'alias', model: 'anthropic/claude-sonnet-4-5', alias: 'smart' } } };
    const viaPrompt = await observed(reviewStep('reviewer'), { tool: 'opencode', record: { agentModels } });
    const viaAgent = await observed(reviewStep('reviewer'), { tool: 'opencode', record: { agentModels } });

    await runLocalDriver(viaPrompt.config, viaPrompt.runId, viaPrompt.workspace, { adapter: reports({ applied: 'prompt' }), toolPaths: opencodeToolPaths });
    await runLocalDriver(viaAgent.config, viaAgent.runId, viaAgent.workspace, { adapter: reports({ applied: 'main' }), toolPaths: opencodeToolPaths });

    const requested = { model: { requested: 'anthropic/claude-sonnet-4-5', alias: 'smart' }, effort: { requested: 'high' } };
    expect((await entry(viaPrompt.config))?.agent).toMatchObject({ v: 1, definition: { name: 'reviewer', applied: 'prompt' }, tool: { name: 'opencode' }, ...requested });
    expect((await entry(viaAgent.config))?.agent).toMatchObject({ definition: { name: 'reviewer', applied: 'main' }, ...requested });
  });

  it('names the alias of defaults.model only for a step it chose the model of', async () => {
    const yaml = `schemaVersion: v1alpha1
name: build
description: Review the project.
defaults:
  model: strong
steps:
  - id: review
    prompt: Review this project.
    agent: reviewer
  - id: plan
    needs: [review]
    prompt: Plan it.
`;
    const { config, workspace, runId } = await observed(yaml);
    fs.mkdirSync(path.join(config.repo.localPath, 'models'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  strong:\n    claude: claude-opus-4-1\n');

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    const [review, plan] = (await endRecord(config))?.steps ?? [];
    expect(review?.agent).toMatchObject({ model: { requested: 'claude-opus-4-1' } });
    expect(review?.agent).not.toHaveProperty('model.alias');
    expect(plan?.agent).toMatchObject({ model: { requested: 'claude-opus-4-1', alias: 'strong' } });
  });

  it('has no definition for a step without agent:', async () => {
    const { config, workspace, runId } = await observed(reviewStep());

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    const published = await entry(config);
    expect(published?.agent).toMatchObject({ v: 1, tool: { name: 'claude' } });
    expect(published?.agent).not.toHaveProperty('definition');
  });

  it('reports no model when the tool names none, and still the requested one', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    const published = await entry(config);
    expect(published).not.toHaveProperty('model');
    expect(published?.agent).toMatchObject({ model: { requested: 'claude-opus-4-1' } });
    expect(published?.agent).not.toHaveProperty('model.reported');
  });

  it('records local changes and no fingerprint after a delivered skill is edited', async () => {
    const { config, workspace, runId, rev, skill } = await observed(reviewStep('reviewer'));
    fs.appendFileSync(skill, 'My own note.\n');

    await runLocalDriver(config, runId, workspace, { adapter: reports({ model: 'claude-opus-4-1' }), toolPaths });

    const published = await entry(config);
    expect(published?.agent).toMatchObject({ team: { revision: rev, localChanges: true } });
    expect(published?.agent).not.toHaveProperty('fingerprint');
  });

  it('requests no model after the deployed agent file\'s model is edited', async () => {
    const { config, workspace, runId, agentFile } = await observed(reviewStep('reviewer'));
    fs.writeFileSync(agentFile, fs.readFileSync(agentFile, 'utf8').replace('claude-opus-4-1', 'claude-haiku-4-5'));

    await runLocalDriver(config, runId, workspace, { adapter: reports(), toolPaths });

    expect((await entry(config))?.agent).not.toHaveProperty('model');
  });

  it.each([
    ['a push base at another commit', (team: string) => ({ pushBaseRevs: [commitFile(team, 'agents/later.yaml')] })],
    ['no delivered baseline', () => ({ delivered: undefined })],
  ])('names no team and no fingerprint for a record with %s', async (_case, record) => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));
    const key = await checkoutRecordKey(config);
    const state = await loadStateForScope(config);
    Object.assign(state.lastPullByWorkspace![key!]!, record(config.repo.localPath));
    await saveStateForScope(state, config);

    await runLocalDriver(config, runId, workspace, { adapter: reports({ model: 'claude-opus-4-1' }), toolPaths });

    const published = await entry(config);
    expect(published?.agent).toMatchObject({ v: 1, tool: { name: 'claude' } });
    expect(published?.agent).not.toHaveProperty('team');
    expect(published?.agent).not.toHaveProperty('fingerprint');
  });

  it('records no observation of a tool that never started', async () => {
    const { config, workspace, runId } = await observed(reviewStep('reviewer'));

    await runLocalDriver(config, runId, workspace, { adapter: createLocalToolAdapter(undefined, () => null), toolPaths });

    expect((await entry(config))?.agent).toEqual({ definition: { name: 'reviewer' } });
  });

  it('gives each pass a loop ran its own agent', async () => {
    const { config, workspace, runId } = await observed(`${reviewStep('reviewer')}    loop: { back_to: review, while: "length(steps.review.passes) < 3", max_iterations: 3 }
`);
    let pass = 0;
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => ({ started: true as const, exitCode: 0, model: `claude-model-${++pass}` })) };

    await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    const published = (await endRecord(config))?.steps ?? [];
    expect(published.map((step) => [step.pass, step.agent && 'model' in step.agent ? step.agent.model?.reported : undefined])).toEqual([
      [1, 'claude-model-1'],
      [2, 'claude-model-2'],
      [3, 'claude-model-3'],
    ]);
  });
});

describe('progress lines on the local driver', () => {
  it('shows each line a command writes to stderr as it writes it, and answers them, masked, with the run\'s end', async () => {
    const { config, workspace, runId } = await workflowFixture(`schemaVersion: v1alpha1
name: build
description: Say what it does.
steps:
  - id: say
    command: printf 'Found 2 entries.\\nUsing ' >&2; sleep 0.1; echo "$DEPLOY_TOKEN" >&2
    requires: { env: [DEPLOY_TOKEN] }
`);
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: DEPLOY_TOKEN\n');
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const shown: string[] = [];

    const done = await runLocalDriver(config, runId, workspace, { hitl: false, progress: (line) => { shown.push(line); } });

    expect(shown).toEqual(['Found 2 entries.', 'Using <REDACTED:DEPLOY_TOKEN>']);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', progress: [{ step: 'say', lines: shown }] } } });
  });
});

describe('a place held open for a conversation a later step continues', () => {
  /** What the toy was asked, in order: each request's type, operation and handle, and each prompt lease's continue. */
  // A request the toy logged to `calls`, and a prompt it was sent, as it appends them to `prompts.jsonl`.
  const AskedSchema = z.object({ type: z.string(), op: z.string().optional(), handle: z.string().optional() });
  type Asked = z.infer<typeof AskedSchema>;
  const ContinueSchema = z.object({ handle: z.string(), op: z.string() });
  const SentSchema = z.object({ op: z.string(), sent: z.object({ step: z.string(), continue: ContinueSchema.optional() }).optional() });

  const toyDriver = async (dir: string, { maxParallel, can = {}, release }: { maxParallel?: number; can?: Record<string, JsonValue>; release?: string } = {}) => {
    const state = path.join(dir, 'toy-state');
    const calls = path.join(dir, 'toy-calls.jsonl');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    const agent = { output: { ok: true }, transcript: true, home: path.join(dir, 'toy-claude'), ...(release !== undefined && { release }) };
    const ready = await runtime.init({ options: { state, calls, agent, can }, mode: 'unattended' });
    onTestFinished(() => runtime.dispose());

    if (!ready.ok) throw new Error(`toy did not start: ${ready.failure.message}`);
    const runtimes: DriverRuntimes = {
      driver: 'toy', asked: 'toy',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, engine: { logins: [], ...(maxParallel !== undefined && { maxParallel }) }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };

    const asked = (): Asked[] => fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => AskedSchema.parse(JSON.parse(line)));
    const leases = (): Array<{ op: string; step: string; continue?: z.infer<typeof ContinueSchema> }> => fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n')
      .map((line) => SentSchema.parse(JSON.parse(line)))
      .flatMap(({ op, sent }) => (sent ? [{ op, step: sent.step, ...(sent.continue && { continue: sent.continue }) }] : []));

    return { runtimes, asked, leases };
  };

  /** The prompt of `step` the toy was sent, and the place it ran in. */
  const promptOf = (asked: Asked[], leases: ReturnType<Awaited<ReturnType<typeof toyDriver>>['leases']>, step: string) => {
    const lease = leases.find((sent) => sent.step === step);
    const prompt = asked.find((call) => call.type === 'prompt' && call.op === lease?.op);

    if (!lease || !prompt?.handle) throw new Error(`no prompt of ${step}: ${JSON.stringify(asked)}`);

    return { ...lease, handle: prompt.handle, at: asked.indexOf(prompt) };
  };

  const closedAt = (asked: Asked[], handle: string): number => asked.findIndex((call) => call.type === 'close' && call.handle === handle);

  const PAIR = `schemaVersion: v1alpha1
name: build
description: Two steps of one conversation.
steps:
  - id: one
    prompt: Plan the change.
    output:
      ok: boolean
  - id: two
    needs: [one]
    session:
      from: one
    prompt: Make the change you planned.
    output:
      ok: boolean
`;

  /** `workflow`'s steps inside a \`workflow\` step \`change\` that opens a workspace they all work in. */
  const inOneWorkspace = (workflow: string): string => {
    const [header = '', steps = ''] = workflow.split('steps:\n');

    return `${header}steps:\n  - id: change\n    workspace: new\n    workflow:\n      steps:\n${steps.replace(/^(?=.)/gmu, '      ')}`;
  };

  it('closes step one\'s place at its report when step two, a top-level step, gets a place of its own', async () => {
    const { config, workspace, runId } = await workflowFixture(PAIR);
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'one');
    const two = promptOf(asked, toy.leases(), 'two');
    expect(two.continue).toBeUndefined();
    expect(closedAt(asked, one.handle)).toBeGreaterThan(-1);
    expect(closedAt(asked, one.handle)).toBeLessThan(two.at);
  }, 30_000);

  it('keeps step one\'s place open until step two reports, and step two\'s lease continues its conversation', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    const two = promptOf(asked, toy.leases(), 'change.two');
    expect(two.continue).toEqual({ handle: one.handle, op: one.op });
    expect(closedAt(asked, one.handle)).toBeGreaterThan(two.at);
    // Step two's own place closes once its report is recorded; step one's, which held the conversation, only after it.
    expect(closedAt(asked, one.handle)).toBeGreaterThan(closedAt(asked, two.handle));
    expect(closedAt(asked, two.handle)).toBeGreaterThan(two.at);
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run was not stored');
    const sessionOf = (id: string) => { const step = run.steps.find((item) => item.id === id); return step && 'session' in step ? step.session : undefined; };
    expect(run.steps.find((step) => step.id === 'change.two')).toMatchObject({ resumed: { tool: 'claude', id: sessionOf('change.one') } });
  }, 30_000);

  it('names the conversation\'s first step in the lease of every later step of a chain', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(`${PAIR}  - id: three
    needs: [two]
    session:
      from: two
    prompt: Test the change.
    output:
      ok: boolean
`));
    const toy = await toyDriver(path.dirname(workspace));

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    const three = promptOf(asked, toy.leases(), 'change.three');
    expect(three.continue).toEqual({ handle: one.handle, op: one.op });
    expect(closedAt(asked, one.handle)).toBeGreaterThan(three.at);
  }, 30_000);

  it('gives step two room under max_parallel: 1 while step one\'s place is held', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const toy = await toyDriver(path.dirname(workspace), { maxParallel: 1 });

    expect(await runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(promptOf(toy.asked(), toy.leases(), 'change.two').continue).toBeDefined();
  }, 30_000);

  it('closes step one\'s place at the run\'s end after the teamai that held it stopped between the two reports', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR.replace('    needs: [one]\n', '    needs: [go]\n').replace('  - id: two\n', '  - id: go\n    needs: [one]\n    choose: { message: Go on?, options: [yes, no] }\n  - id: two\n')));
    const dir = path.dirname(workspace);
    const before = await toyDriver(dir);
    // Nobody answers the gate after step one, so this teamai stops with step one's place held.
    const unanswered = async (): Promise<string> => { throw new Error('closed'); };

    expect(await runLocalDriver(config, runId, workspace, { runtimes: before.runtimes, hitl: true, question: unanswered })).toMatchObject({ error: { code: 'interrupted' } });
    const one = promptOf(before.asked(), before.leases(), 'change.one');
    expect(closedAt(before.asked(), one.handle)).toBe(-1);

    const after = await toyDriver(dir);
    expect(await runLocalDriver(config, runId, workspace, { runtimes: after.runtimes, hitl: true, question: async () => 'yes' })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = after.asked();
    const two = promptOf(asked, after.leases(), 'change.two');
    expect(two.continue).toEqual({ handle: one.handle, op: one.op });
    expect(closedAt(asked, one.handle)).toBeGreaterThan(two.at);
  }, 30_000);

  it('closes step one\'s held place when the run is cancelled while step two runs', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR));
    const dir = path.dirname(workspace);
    // Step one's agent finishes at once; step two's works until the run is cancelled.
    fs.writeFileSync(path.join(dir, 'release-change.one'), '');
    const toy = await toyDriver(dir, { release: path.join(dir, 'release-{step}') });
    const driving = runLocalDriver(config, runId, workspace, { runtimes: toy.runtimes });

    for (let waited = 0; !fs.existsSync(path.join(dir, 'toy-state', 'prompts.jsonl')) || !toy.leases().some((lease) => lease.step === 'change.two'); waited += 20) {
      if (waited > 20_000) throw new Error('step two was not sent');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(await cancelRun(config, runId, await knownSecrets(config))).toMatchObject({ data: { run: { status: 'cancelled' } } });
    expect(await driving).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    const one = promptOf(toy.asked(), toy.leases(), 'change.one');
    expect(closedAt(toy.asked(), one.handle)).toBeGreaterThan(-1);
  }, 30_000);

  it('lets step one\'s place close at the report of a step that continues its session on another runtime', async () => {
    const { config, workspace, runId } = await workflowFixture(inOneWorkspace(PAIR.replace('    prompt: Make the change you planned.\n', '    prompt: Make the change you planned.\n    tool: codex\n')));
    const toy = await toyDriver(path.dirname(workspace), { can: { tools: ['claude'] } });
    const local = { kind: 'local' as const, use: 'local' as const, engine: { logins: [] } };
    const adapter: LocalToolAdapter = {
      run: async () => ({ started: true, exitCode: 0, session: 'codex-session', output: { ok: true } }),
      runInteractive: async () => ({ started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'not interactive' } }),
    };

    expect(await runLocalDriver(config, runId, workspace, { adapter, runtimes: { ...toy.runtimes, runtimes: [...toy.runtimes.runtimes, local] } })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const asked = toy.asked();
    const one = promptOf(asked, toy.leases(), 'change.one');
    expect(toy.leases().map((lease) => lease.step)).toEqual(['change.one']);
    expect(closedAt(asked, one.handle)).toBeGreaterThan(-1);
  }, 30_000);
});
