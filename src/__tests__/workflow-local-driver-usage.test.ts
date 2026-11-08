import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LocalToolAdapter, type LocalToolResult } from '../workflow/drivers/local/local-tool-adapter.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { readRun } from '../workflow/store.js';
import { log } from '../utils/logger.js';
import { dirs, parallelFixture, toolPaths } from './helpers/workflow-local-driver-fixture.js';
import { dirs as handoffDirs, onGitHub, originFile, startIn, team } from './helpers/workflow-handoff-fixture.js';

_setDriverPollMs(20);

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
    let hitAt: number | undefined;

    const adapter: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_tool, input) => {
        const step = input.prompt.includes('first') ? 'one' : input.prompt.includes('second') ? 'two' : 'three';
        launches.push({ step, at: Date.now() });

        if (hitAt === undefined) {
          hitAt = Date.now();

          return claudeLimit(resetsAt);
        }

        return { started: true as const, exitCode: 0 };
      }),
    };

    const done = await runLocalDriver(config, runId, workspace, { adapter, toolPaths });

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'one', status: 'succeeded' }, { id: 'two', status: 'succeeded' }, { id: 'three', status: 'succeeded' }] });
    // The step beside the one that hit the limit had already launched; every later launch waited for the reset.
    const later = launches.filter(({ at }) => hitAt !== undefined && at > hitAt + 50);
    expect(later.length).toBeGreaterThan(0);
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

    expect(stopped).toEqual({ error: { code: 'usage_limited', message: expect.stringMatching(new RegExp(`^Run ${runId} waits: claude hit its usage limit, which resets at .+, past the 6 hours an unattended run waits for it, and it could not be offered on teamai-reports: .+\\. Continue it here once the limit resets: teamai workflow resume ${runId}, or publish it from here for another machine: teamai workflow publish ${runId}$`)) } });
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: [{ id: 'fix', status: 'pending' }] });
  });
});
