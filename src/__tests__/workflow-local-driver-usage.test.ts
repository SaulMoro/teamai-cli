import fs from 'node:fs';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { type LocalToolAdapter, type LocalToolResult } from '../workflow/drivers/local/local-tool-adapter.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { readRun } from '../workflow/store.js';
import { log } from '../utils/logger.js';
import { dirs, parallelFixture, toolPaths } from './helpers/workflow-local-driver-fixture.js';
import { dirs as handoffDirs, onGitHub, originFile, startIn, team } from './helpers/workflow-handoff-fixture.js';

_setDriverPollMs(20);

// The person at the terminal: each question gets the next line of `typed`.
const terminal = vi.hoisted(() => ({ typed: [] as string[], asked: [] as string[] }));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async (prompt: string) => {
      terminal.asked.push(prompt);
      const line = terminal.typed.shift();
      if (line === undefined) throw new Error('closed');
      return line;
    },
    close: () => undefined,
  }),
}));

/** A person attends at a terminal, typing `lines` in turn. */
function attendedAt(lines: string[]): void {
  terminal.typed = [...lines];
  terminal.asked = [];
  for (const stream of [process.stdin, process.stderr]) {
    const { isTTY } = stream;
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    onTestFinished(() => { Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true }); });
  }
  vi.stubEnv('TEAMAI_MODE', 'attended');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of [...dirs.splice(0), ...handoffDirs.splice(0)]) fs.rmSync(dir, { recursive: true, force: true });
});

const threePrompts = `schemaVersion: v1alpha1
name: build
description: Three prompts with no needs.
steps:
  - id: one
    needs: []
    workspace: new
    prompt: Implement the first part.
  - id: two
    needs: []
    workspace: new
    prompt: Implement the second part.
  - id: three
    needs: []
    workspace: new
    prompt: Implement the third part.
`;

/** What Claude Code's older text says of a limit that resets at `resetsAt`, in whole seconds since the epoch. */
function claudeLimit(resetsAt: number): LocalToolResult {
  return { started: true, exitCode: 1, failure: { code: 'usage_limited', message: `claude hit its usage limit: Claude AI usage limit reached|${Math.ceil(resetsAt / 1000)}` } };
}

describe('a usage limit across the parallel steps of a run, under the local driver', () => {
  it('launches nothing more on the tool after one step stops on its limit, and runs every step once it resets', async () => {
    const { config, workspace, runId } = await parallelFixture(threePrompts, 2);
    const resetsAt = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    const launches: Array<{ step: string; at: number }> = [];
    // Both slots launch before the limit lands, and the second step finishes only once the driver read it,
    // so every launch past those two is one the driver made after the limit.
    let secondLaunched = (): void => undefined;
    const secondRunning = new Promise<void>((resolve) => { secondLaunched = resolve; });
    let limitRead = (): void => undefined;
    const limitWasRead = new Promise<void>((resolve) => { limitRead = resolve; });
    const warn = log.warn.bind(log);
    vi.spyOn(log, 'warn').mockImplementation((message: string) => {
      if (message.includes('hit its usage limit')) limitRead();
      warn(message);
    });

    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, input) => {
        const step = input.prompt.includes('first') ? 'one' : input.prompt.includes('second') ? 'two' : 'three';
        launches.push({ step, at: Date.now() });
        if (launches.length === 1) {
          await secondRunning;

          return claudeLimit(resetsAt);
        }
        if (launches.length === 2) {
          secondLaunched();
          await limitWasRead;
        }

        return { started: true as const, exitCode: 0 };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'one', status: 'succeeded' }, { id: 'two', status: 'succeeded' }, { id: 'three', status: 'succeeded' }] });
    // The step that hit the limit runs again, and the step that never launched runs, both after the reset.
    const [limited, beside] = launches.map(({ step }) => step);
    const later = launches.slice(2);
    expect(later.map(({ step }) => step).sort()).toEqual(['one', 'two', 'three'].filter((step) => step !== beside).sort());
    expect(later.map(({ step }) => step)).toContain(limited);
    expect(later.every(({ at }) => at >= resetsAt)).toBe(true);
  }, 20_000);

  const FIX = `schemaVersion: v1alpha1
name: fix
description: One prompt.
steps:
  - id: fix
    prompt: Fix the bug.
`;

  /** Codex's text for a limit that resets two days from now, past the wait an unattended run gives it. */
  const weekly: LocalToolResult = { started: true, exitCode: 1, failure: { code: 'usage_limited', message: 'claude hit its usage limit: You\'ve hit your usage limit. Try again in 2 days 3 hours 4 minutes.' } };

  it('offers an unattended run on teamai-reports when the limit resets past its wait, and leaves the step pending', async () => {
    const acme = team({ fix: FIX });
    const ci = await acme.member('ci');
    onGitHub(acme.business, [ci]);
    ci.config.workflows = { tools: { default: 'claude' } };
    const runId = await startIn(ci, 'fix');
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => weekly) };
    const info = vi.spyOn(log, 'info');
    vi.stubEnv('TEAMAI_MODE', 'unattended');

    expect(await runLocalDriver(ci.config, runId, ci.checkout, { adapter, toolPaths })).toEqual({
      data: { handoff: { run: runId, steps: ['fix'], resume: `teamai workflow resume ${runId} --claim` } },
    });

    expect(adapter.run).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^Step "fix" waits: claude hit its usage limit, which resets at .+, past the 6 hours an unattended run waits for it\\. So run ${runId} is offered on teamai-reports: another machine continues it with teamai workflow resume ${runId} --claim\\. To continue it here once the limit resets: teamai workflow resume ${runId}$`)));
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ owner: { user: 'ci' }, offered: { at: expect.any(String) }, steps: [{ id: 'fix', status: 'pending' }] });
  });

  it('stops an unattended run whose limit resets past its wait and that it cannot offer, naming both ways on, with the step pending', async () => {
    const { config, workspace, runId } = await parallelFixture(FIX.replace('name: fix', 'name: build'), 1);
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => weekly) };
    vi.stubEnv('TEAMAI_MODE', 'unattended');

    const stopped = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(stopped).toEqual({ error: { code: 'usage_limited', message: expect.stringMatching(new RegExp(`^Run ${runId} waits: claude hit its usage limit, which resets at .+, past the 6 hours an unattended run waits for it, and it could not be offered on teamai-reports: .+\\. Once the limit resets, continue it here with: teamai workflow resume ${runId}, or hand it to another machine with: teamai workflow publish ${runId}$`)) } });
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: [{ id: 'fix', status: 'pending' }] });
  });

  it('asks a person who attends, and offers the run to another machine when they choose to', async () => {
    const acme = team({ fix: FIX });
    const alice = await acme.member('alice');
    onGitHub(acme.business, [alice]);
    alice.config.workflows = { tools: { default: 'claude' } };
    const runId = await startIn(alice, 'fix');
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => weekly) };
    const info = vi.spyOn(log, 'info');
    attendedAt(['offer']);

    expect(await runLocalDriver(alice.config, runId, alice.checkout, { adapter, toolPaths })).toEqual({
      data: { handoff: { run: runId, steps: ['fix'], resume: `teamai workflow resume ${runId} --claim` } },
    });

    expect(terminal.asked).toEqual([expect.stringMatching(/^claude hit its usage limit, which resets at .+\. Wait here until it resets, or offer run r[0-9a-f]+ to another machine on teamai-reports\? \[wait\/offer\] $/)]);
    expect(info).toHaveBeenCalledWith(`Run ${runId} is offered on teamai-reports, as you chose: another machine continues it with teamai workflow resume ${runId} --claim. To continue it here once the limit resets: teamai workflow resume ${runId}`);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ offered: { at: expect.any(String) }, steps: [{ id: 'fix', status: 'pending' }] });
  });

  it('asks a person who attends, and waits for the reset when they choose to', async () => {
    const { config, workspace, runId } = await parallelFixture(FIX.replace('name: fix', 'name: build'), 1);
    const resetsAt = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    const launched: number[] = [];
    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async () => {
        launched.push(Date.now());
        return launched.length === 1 ? claudeLimit(resetsAt) : { started: true as const, exitCode: 0 };
      }),
    };
    attendedAt(['wait']);

    expect(await runLocalDriver(config, runId, workspace, { adapter, toolPaths })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(terminal.asked).toHaveLength(1);
    expect(launched).toHaveLength(2);
    expect(launched[1]).toBeGreaterThanOrEqual(resetsAt);
  }, 20_000);

  it('stops when the person closes the question, naming resume here and publish elsewhere', async () => {
    const { config, workspace, runId } = await parallelFixture(FIX.replace('name: fix', 'name: build'), 1);
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async () => weekly) };
    attendedAt([]);

    expect(await runLocalDriver(config, runId, workspace, { adapter, toolPaths })).toEqual({ error: {
      code: 'interrupted',
      message: `The question on the usage limit closed without an answer. Once the limit resets, continue run ${runId} here with: teamai workflow resume ${runId}, or hand it to another machine with: teamai workflow publish ${runId}`,
    } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'fix', status: 'pending' }] });
  });
});
