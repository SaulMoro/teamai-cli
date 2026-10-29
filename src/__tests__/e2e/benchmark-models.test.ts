/**
 * Real CLI: every arm's trials run the model its alias named for its tool when the run started, read from the team's
 * aliases at the run's team revision, on every driver, whatever the aliases say later. The member's own aliases count
 * only with --member-aliases, and the table and the record say whose aliases resolved each model.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { fakeTrialDriver } from '../helpers/fake-trial-driver.js';

const SUITE = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
  model: strong
arms:
  - name: strong
  - name: fast
    model: fast
  - name: codex
    tool: codex
repetitions: 1
timeout: 10m
`;
const ALIASES = `aliases:
  strong:
    claude: { model: claude-strong-1, effort: high }
    codex: { model: gpt-strong-1, effort: high }
  fast:
    claude: claude-fast-1
`;
const LATER_ALIASES = `aliases:
  strong:
    claude: claude-strong-2
    codex: gpt-strong-2
  fast:
    claude: claude-fast-2
`;
const MEMBER_ALIASES = 'aliases:\n  strong:\n    claude: claude-member-1\n';

const AgentSchema = z.object({
  tool: z.object({ name: z.string() }),
  model: z.object({ requested: z.string().optional(), reported: z.string().optional() }).optional(),
  effort: z.object({ requested: z.string().optional() }).optional(),
}).passthrough();
const RunSchema = z.object({ status: z.string(), steps: z.array(z.object({ id: z.string(), agent: AgentSchema.optional() }).passthrough()) });
const RecordSchema = z.object({
  benchmark: z.object({
    arms: z.array(z.object({ name: z.string() }).passthrough()),
    trials: z.array(z.object({ arm: z.string(), result: z.string(), durationMs: z.number().optional() }).passthrough()),
  }),
});
const DoneSchema = z.object({ done: z.object({ run: z.string(), benchmark: z.object({ text: z.string() }) }) });

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function modelFixture(aliases = ALIASES): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, suite: SUITE, team: { 'models/aliases.yaml': aliases },
    firstLaunch: 'pulls-a-team-change', teamChange: { 'models/aliases.yaml': LATER_ALIASES },
  });
  fixtures.push(fixture);
  fs.mkdirSync(path.join(fixture.home, '.teamai', 'models'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, '.teamai', 'models', 'aliases.yaml'), MEMBER_ALIASES);
  return fixture;
}

/** Runs the benchmark on the local driver, and answers its run and the results text its `done` carries. */
async function runLocally(fixture: BenchmarkFixture, args: string[] = []): Promise<{ runId: string; text: string }> {
  const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local', ...args]);
  const done = DoneSchema.safeParse(envelope(started).data);
  if (!done.success) throw new Error(`no done: ${said(started)}`);
  return { runId: done.data.done.run, text: done.data.done.benchmark.text };
}

const DRIVERS: Array<{ name: string; run(fixture: BenchmarkFixture): Promise<{ runId: string; text: string }> }> = [
  { name: 'the local driver', run: (fixture) => runLocally(fixture) },
  {
    name: 'a fake external driver',
    run: async (fixture) => {
      const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark']);
      const runId = z.object({ run: z.string() }).parse(envelope(started).data).run;
      const driver = fakeTrialDriver({
        teamai: fixture.teamai, env: fixture.env, pauseMs: 500,
        tools: { claude: path.join(fixture.bin, 'claude'), codex: path.join(fixture.bin, 'codex') },
      });
      const result = await driver.drive({ runId, can: { workspace: ['read-only', 'new', 'continue'], isolation: 'sandbox', tools: ['claude', 'codex'], trials: ['claude', 'codex'] }, prepare: true, maxPolls: 10 });
      if (result.done?.text === undefined) throw new Error(`the run did not end: ${JSON.stringify(result)}`);
      return { runId, text: result.done.text };
    },
  },
];

describe.each(DRIVERS)('benchmark arm models on $name', ({ run }) => {
  it('runs each arm on the model the team aliases named at start, also after the aliases change and are pulled during the run', async () => {
    const fixture = await modelFixture();

    const { runId, text } = await run(fixture);

    expect(fs.readFileSync(path.join(fixture.teamClone, 'models', 'aliases.yaml'), 'utf8')).toBe(LATER_ALIASES);
    expect(fixture.toolLaunches().map(({ tool, model, effort }) => ({ tool, model, effort }))).toEqual([
      { tool: 'claude', model: 'claude-strong-1', effort: 'high' }, { tool: 'claude', model: 'claude-fast-1', effort: null }, { tool: 'codex', model: 'gpt-strong-1', effort: 'high' },
    ]);
    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.status).toBe('succeeded');
    const agentOf = (arm: string) => stored.steps.find((step) => step.id === `trials.r1.fix.${arm}.prompt`)?.agent;
    expect(agentOf('strong')).toMatchObject({ tool: { name: 'claude' }, model: { requested: 'claude-strong-1' }, effort: { requested: 'high' } });
    expect(agentOf('fast')).toMatchObject({ tool: { name: 'claude' }, model: { requested: 'claude-fast-1' } });
    expect(agentOf('codex')).toMatchObject({ tool: { name: 'codex' }, model: { requested: 'gpt-strong-1' }, effort: { requested: 'high' } });
    const record = RecordSchema.parse(fixture.endRecord(runId)).benchmark;
    expect(record.arms).toEqual([
      { name: 'strong', tool: 'claude', model: 'claude-strong-1', alias: 'strong', effort: 'high', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
      { name: 'fast', tool: 'claude', model: 'claude-fast-1', alias: 'fast', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
      { name: 'codex', tool: 'codex', model: 'gpt-strong-1', alias: 'strong', effort: 'high', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
    ]);
    expect(record.trials.map(({ result, durationMs }) => ({ result, durationMs }))).toEqual(Array.from({ length: 3 }, () => ({ result: 'passed', durationMs: expect.any(Number) })));
    expect(record.trials.find((trial) => trial.arm === 'strong')).toMatchObject({ tokens: { input: 4, output: 2 }, cost: { amount: 0.25, unit: 'USD' } });
    expect(text).toContain('| strong | claude | claude-strong-1 high (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(text).toContain('| codex | codex | gpt-strong-1 high (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(text).toMatch(/\| fast \| 6 \(1\) \| \d+\.\d s \(1\) \| 0\.25 USD \(1\) \|/);
  }, 120_000);
});

describe('benchmark arm models at start', () => {
  it('resolves with the member\'s aliases under --member-aliases, and shows member as the source of each model they decided', async () => {
    const fixture = await modelFixture();

    const { runId, text } = await runLocally(fixture, ['--member-aliases']);

    expect(fixture.toolLaunches().map(({ model }) => model)).toEqual(['claude-member-1', 'claude-fast-1', 'gpt-strong-1']);
    expect(RecordSchema.parse(fixture.endRecord(runId)).benchmark.arms).toMatchObject([
      { name: 'strong', model: 'claude-member-1', source: 'member' },
      { name: 'fast', model: 'claude-fast-1', source: 'team' },
      { name: 'codex', model: 'gpt-strong-1', source: 'team' },
    ]);
    expect(text).toContain('| strong | claude | claude-member-1 (member) |');
  }, 120_000);

  it('refuses to start an arm whose alias names no model for its tool, and leaves no run and no record', async () => {
    const fixture = await modelFixture('aliases:\n  strong:\n    claude: claude-strong-1\n  fast:\n    claude: claude-fast-1\n');

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);

    expect(envelope(started).error).toEqual({
      code: 'arm_model_missing',
      message: 'Arm "codex" uses model alias "strong", which has no model for codex in models/aliases.yaml. Add one and start again.',
    });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
    const reports = (() => {
      try {
        return execFileSync('git', ['--git-dir', fixture.teamOrigin, 'ls-tree', '-r', '--name-only', 'teamai-reports'], { encoding: 'utf8' });
      } catch {
        return '';
      }
    })();
    expect(reports).not.toContain('workflows/runs/');
  }, 120_000);

  it.each([
    {
      origin: 'a member alias resolves to a credential URL', suite: SUITE, args: ['--member-aliases'],
      member: 'aliases:\n  strong:\n    claude: https://member:private-password-123@models.example.test/private-model\n',
      error: 'Arm "strong" has a model that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. Fix your entry in ~/.teamai/models/aliases.yaml, or start again without --member-aliases.',
    },
    {
      origin: 'the suite names a local path', suite: SUITE.replace('  model: strong', '  model: /home/member/models/private.gguf'), args: [], member: undefined,
      error: 'Arm "strong" has a model that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. Fix the suite or the team\'s models/aliases.yaml, push it, run teamai pull, and start again.',
    },
  ])('refuses to start when $origin, and leaves no run and no record', async ({ suite, args, member, error }) => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, suite, team: { 'models/aliases.yaml': ALIASES } });
    fixtures.push(fixture);
    if (member) {
      fs.mkdirSync(path.join(fixture.home, '.teamai', 'models'), { recursive: true });
      fs.writeFileSync(path.join(fixture.home, '.teamai', 'models', 'aliases.yaml'), member);
    }

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local', ...args]);

    expect(envelope(started).error).toEqual({ code: 'arm_unpublishable', message: error });
    expect(started.stdout + started.stderr).not.toContain('private-password-123');
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);
});
