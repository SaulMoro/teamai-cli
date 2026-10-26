/**
 * Real CLI: every trial runs with the team assets of the run's frozen team revision, delivered into its own clone by its
 * own install, whatever the member's checkout pulls during the run, and nothing of that install reaches the member.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, fixTask, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { fakeTrialDriver } from '../helpers/fake-trial-driver.js';

const TWO_REPETITIONS = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 2
timeout: 10m
`;
const SKILL = '---\nname: fixer\ndescription: Fixes the answer.\n---\nMake the answer right.\n';
const SANDBOX_CLAUDE = { workspace: ['read-only', 'new', 'continue'], isolation: 'sandbox', trials: ['claude'] };
const AgentSchema = z.object({
  team: z.object({ revision: z.string(), localChanges: z.boolean() }).passthrough().optional(),
  project: z.object({ commit: z.string() }).passthrough().optional(),
}).passthrough();
const RunSchema = z.object({
  status: z.string(),
  steps: z.array(z.object({ id: z.string(), status: z.string(), agent: AgentSchema.optional() }).passthrough()),
});
/** A check that passes only when the prompt's commit changed answer.js and nothing else. */
const ONLY_ANSWER_CHANGED = `const changed = require('node:child_process').execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).trim();
if (changed !== 'answer.js') throw new Error('The commit changed: ' + changed);
require('./test.js');
`;
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const UNPULLABLE = 'Benchmarks start from the team revision this checkout last pulled, and it has none that another machine can pull. Push any team changes, run teamai pull, and start again.';

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function startedRun(fixture: BenchmarkFixture, args: string[] = []): Promise<string> {
  const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', ...args]);
  const answer = envelope(started);
  const run = answer.data?.run ?? z.object({ run: z.string() }).safeParse(answer.data?.done).data?.run;
  if (typeof run !== 'string') throw new Error(`no run: ${said(started)}`);
  return run;
}

const DRIVERS: Array<{ name: string; run(fixture: BenchmarkFixture): Promise<string> }> = [
  { name: 'the local driver', run: (fixture) => startedRun(fixture, ['--driver', 'local']) },
  {
    name: 'a fake external driver',
    run: async (fixture) => {
      const runId = await startedRun(fixture);
      const driver = fakeTrialDriver({ teamai: fixture.teamai, env: fixture.env, pauseMs: 500, tools: { claude: path.join(fixture.bin, 'claude') } });
      await driver.drive({ runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 10 });
      return runId;
    },
  },
];

describe.each(DRIVERS)('trial team assets on $name', ({ run }) => {
  it('gives every trial the frozen team revision and the starting commit, also after the member pulls a team change', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], suite: TWO_REPETITIONS, firstLaunch: 'pulls-a-team-change',
      team: { 'skills/fixer/SKILL.md': SKILL }, app: { 'AGENTS.md': 'Starting agents.\n', 'CLAUDE.md': 'Starting claude.\n' },
    });
    fixtures.push(fixture);
    fs.writeFileSync(path.join(fixture.work, 'AGENTS.md'), 'The member edited this.\n');
    fs.writeFileSync(path.join(fixture.work, 'CLAUDE.md'), 'The member edited this too.\n');
    const settings = path.join(fixture.home, '.claude', 'settings.json');
    const settingsBefore = fs.readFileSync(settings);
    const baseline = git(fixture.teamClone, ['rev-parse', 'HEAD']);

    const runId = await run(fixture);

    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.status).toBe('succeeded');
    for (const repetition of [1, 2]) {
      expect(stored.steps.find((step) => step.id === `trials.r${repetition}.fix.claude.prompt`)?.agent).toMatchObject({
        team: { revision: baseline, localChanges: false }, project: { commit: fixture.startingCommit },
      });
    }
    expect(git(fixture.teamClone, ['rev-parse', 'HEAD'])).not.toBe(baseline);
    const launches = fixture.toolLaunches();
    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      expect(launch.paths).toContain('.claude/skills/fixer/SKILL.md');
      expect(launch.agentFiles).toEqual({ 'AGENTS.md': 'Starting agents.\n', 'CLAUDE.md': 'Starting claude.\n' });
    }
    expect(fixture.hookCalls()).toEqual([]);
    expect(fs.readFileSync(settings)).toEqual(settingsBefore);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 180_000);
});

describe('trial team assets', () => {
  it("commits only the agent's edits, not the team assets the trial's install delivered", async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], team: { 'skills/fixer/SKILL.md': SKILL }, app: { 'check.js': ONLY_ANSWER_CHANGED },
      tasks: { fix: fixTask('{{startingCommit}}').replace('run: node test.js', 'run: node check.js') },
    });
    fixtures.push(fixture);

    const runId = await startedRun(fixture, ['--driver', 'local']);

    expect(fixture.toolLaunches()[0]?.paths).toContain('.claude/skills/fixer/SKILL.md');
    expect(RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);

  it('pins the team revision with the team remote unreachable', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], team: { 'skills/fixer/SKILL.md': SKILL } });
    fixtures.push(fixture);
    const baseline = git(fixture.teamClone, ['rev-parse', 'HEAD']);
    fs.renameSync(fixture.teamOrigin, `${fixture.teamOrigin}.gone`);

    const runId = await startedRun(fixture, ['--driver', 'local']);

    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.prompt')?.agent).toMatchObject({ team: { revision: baseline } });
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
    expect(fixture.toolLaunches()[0]?.paths).toContain('.claude/skills/fixer/SKILL.md');
  }, 120_000);

  it('runs a killed trial again in a fresh clone on workflow resume, and removes the first', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], firstLaunch: 'kills-its-driver' });
    fixtures.push(fixture);

    const killed = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const [runId] = fixture.runIds();
    if (runId === undefined) throw new Error(`no run: ${said(killed)}`);
    const resumed = await fixture.teamai(['workflow', 'resume', runId]);

    expect(killed.code, said(killed)).not.toBe(0);
    expect(resumed.code, said(resumed)).toBe(0);
    const [first, second, ...more] = fixture.toolLaunches();
    expect(more).toEqual([]);
    expect(second?.cwd).not.toBe(first?.cwd);
    expect(fs.existsSync(path.dirname(first?.cwd ?? fixture.tmp))).toBe(false);
    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.status).toBe('succeeded');
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('prepares a handed-back prompt again in a fresh clone, and removes the first', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    const runId = await startedRun(fixture);
    const next = async (): Promise<{ attempt: string; cwd: string }> => {
      const answer = envelope(await fixture.teamai(['workflow', 'next', runId, '--prepare', '--json', JSON.stringify({
        driver: { kind: 'external', machine: 'ci', workspace: '/ci', can: SANDBOX_CLAUDE }, running: [],
      })]));
      return z.object({ lease: z.object({ attempt: z.string(), cwd: z.string() }) }).parse(answer.data).lease;
    };

    const first = await next();
    const again = await next();

    expect(again.attempt).toBe(first.attempt);
    expect(again.cwd).not.toBe(first.cwd);
    expect(fs.existsSync(again.cwd)).toBe(true);
    expect(fs.existsSync(path.dirname(first.cwd))).toBe(false);
  }, 120_000);

  it('fetches a starting commit the checkout lacks from the suite repo at start, and a trial clones it offline', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    const later = fixture.pushProduct({ 'README.md': '# app, later\n' });
    fixture.pushTeam({ 'benchmarks/fix/tasks/fix.yaml': fixTask(later) });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);

    const runId = await startedRun(fixture);
    fs.renameSync(fixture.productOrigin, `${fixture.productOrigin}.gone`);
    const resumed = await fixture.teamai(['workflow', 'resume', runId]);

    expect(resumed.code, said(resumed)).toBe(0);
    expect(fixture.toolLaunches()[0]?.head).toBe(later);
    expect(RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);

  it.each([
    ['its delivered team assets were edited', async (fixture: BenchmarkFixture) => {
      fs.appendFileSync(path.join(fixture.work, '.claude', 'skills', 'fixer', 'SKILL.md'), 'A local edit.\n');
    }],
    ['its team revision is on no branch of the team remote', async (fixture: BenchmarkFixture) => {
      fs.writeFileSync(path.join(fixture.teamClone, 'local.md'), 'Not pushed.\n');
      git(fixture.teamClone, ['add', '-A'], fixture.env);
      git(fixture.teamClone, ['commit', '-qm', 'not pushed'], fixture.env);
      const pulled = await fixture.teamai(['pull']);
      expect(pulled.code, said(pulled)).toBe(0);
    }],
  ])('refuses to start when %s, and leaves no run', async (_case, change) => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], team: { 'skills/fixer/SKILL.md': SKILL } });
    fixtures.push(fixture);
    await change(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: { code: 'team_revision_unpullable', message: UNPULLABLE } });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);

  it('refuses to start when a task starts from a commit neither the checkout nor the suite repo has', async () => {
    const missing = 'f'.repeat(40);
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], tasks: { fix: fixTask(missing) } });
    fixtures.push(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: {
      code: 'commit_unreachable',
      message: `Task "fix" starts from fffffff, which neither this checkout nor ${PRODUCT_URL} has. Push it, or fix startingCommit, and start again.`,
    } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);
});
