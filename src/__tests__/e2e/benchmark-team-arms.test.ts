/**
 * Real CLI: an arm's `team` decides the team assets its trials get: the revision this checkout pulled, none, another
 * revision of the team repo, or the pulled revision without some skills.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const TEAM_SKILLS = new Set(['fixer', 'helper', 'newer']);
const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const RunSchema = z.object({
  steps: z.array(z.object({ id: z.string(), agent: z.object({ team: z.object({ revision: z.string() }).passthrough().optional() }).passthrough().optional() }).passthrough()),
});
const RecordSchema = z.object({
  benchmark: z.object({
    arms: z.array(z.object({ name: z.string(), team: z.unknown() }).passthrough()),
    trials: z.array(z.object({ arm: z.string(), order: z.number(), result: z.string() }).passthrough()),
  }).passthrough(),
});

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function suite(arms: string): string {
  return `schemaVersion: v1alpha1\nname: fix\nrepo: ${PRODUCT_URL}\ndefaults:\n  tool: claude\n${arms}repetitions: 1\ntimeout: 10m\n`;
}

/**
 * A team whose first revision has skills fixer and helper, and whose next, pulled, adds skill newer and the suite whose
 * arms `armsOf` writes knowing the first revision.
 */
async function twoRevisions(armsOf: (first: string) => string): Promise<{ fixture: BenchmarkFixture; first: string; pulled: string }> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, tools: ['claude'],
    team: { 'skills/fixer/SKILL.md': SKILL('fixer'), 'skills/helper/SKILL.md': SKILL('helper') },
  });
  fixtures.push(fixture);
  const first = git(fixture.teamClone, ['rev-parse', 'HEAD']);
  fixture.pushTeam({ 'skills/newer/SKILL.md': SKILL('newer'), 'benchmarks/fix/suite.yaml': suite(armsOf(first)) });
  const pulled = await fixture.teamai(['pull']);
  expect(pulled.code, said(pulled)).toBe(0);
  return { fixture, first, pulled: git(fixture.teamClone, ['rev-parse', 'HEAD']) };
}

/** The team skills each arm's trial saw in its clone, by arm, from the launches in trial order; teamai's own skills left out. */
function skillsByArm(fixture: BenchmarkFixture, runId: string): Record<string, string[]> {
  const { trials } = RecordSchema.parse(fixture.endRecord(runId)).benchmark;
  const arms = [...trials].sort((left, right) => left.order - right.order).map(({ arm }) => arm);
  return Object.fromEntries(fixture.toolLaunches().map((launch, index) => [
    arms[index],
    launch.paths.flatMap((file) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1] ?? []).filter((skill) => TEAM_SKILLS.has(skill)).sort(),
  ]));
}

async function endedRun(fixture: BenchmarkFixture): Promise<string> {
  const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
  expect(started.code, said(started)).toBe(0);
  const [runId] = fixture.runIds();
  if (runId === undefined) throw new Error(`no run: ${said(started)}`);
  return runId;
}

describe('benchmark arm team', () => {
  it('gives each arm of a team matrix its own team assets, and records the revision each trial ran on', async () => {
    const { fixture, pulled } = await twoRevisions(() => 'matrix:\n  team: [pulled, none, { without: [fixer] }]\n');

    const runId = await endedRun(fixture);

    const record = RecordSchema.parse(fixture.endRecord(runId));
    expect(record.benchmark.arms.map(({ name, team }) => ({ name, team }))).toEqual([
      { name: 'pulled', team: { kind: 'pulled', revision: pulled } },
      { name: 'none', team: { kind: 'none' } },
      { name: 'without-fixer', team: { kind: 'without', skills: ['fixer'], revision: pulled } },
    ]);
    expect(skillsByArm(fixture, runId)).toEqual({ 'pulled': ['fixer', 'helper', 'newer'], 'none': [], 'without-fixer': ['helper', 'newer'] });
    const { steps } = RunSchema.parse(fixture.runFile(runId));
    const ranOn = (arm: string): string | undefined => steps.find((step) => step.id === `trials.r1.fix.${arm}.prompt`)?.agent?.team?.revision;
    expect([ranOn('pulled'), ranOn('none'), ranOn('without-fixer')]).toEqual([pulled, undefined, pulled]);
    expect(record.benchmark.trials.map(({ result }) => result)).toEqual(['passed', 'passed', 'passed']);
    const bare = record.benchmark.trials.find(({ arm }) => arm === 'none')?.order ?? 0;
    expect(fixture.toolLaunches()[bare - 1]?.paths.filter((file) => file.startsWith('.claude/'))).toEqual([]);
  }, 240_000);

  it("gives an arm that names another revision of the team repo that revision's assets", async () => {
    const { fixture, first, pulled } = await twoRevisions((before) => `arms:\n  - name: now\n  - name: before\n    team: ${before}\n`);

    const runId = await endedRun(fixture);

    expect(RecordSchema.parse(fixture.endRecord(runId)).benchmark.arms.map(({ team }) => team)).toEqual([
      { kind: 'pulled', revision: pulled },
      { kind: 'ref', ref: first, revision: first },
    ]);
    expect(skillsByArm(fixture, runId)).toEqual({ now: ['fixer', 'helper', 'newer'], before: ['fixer', 'helper'] });
  }, 240_000);

  it.each([
    ['a ref the team repo does not have', () => 'arms:\n  - name: now\n  - name: gone\n    team: no-such-branch\n', 'arm_team_unresolved',
      'Arm "gone" runs on team ref "no-such-branch", which is no branch, tag or commit of this checkout\'s team repo that holds teamai.yaml. Its branches: main. Fetch it, or fix the arm\'s team, push it, run teamai pull, and start again.'],
    ['a skill the pulled revision does not have', () => 'arms:\n  - name: now\n  - name: ablated\n    team: { without: [nope] }\n', 'arm_team_unresolved',
      'Arm "ablated" runs without skill "nope", and the team revision this checkout pulled has no skill of that name. Fix the arm\'s team, push it, run teamai pull, and start again.'],
  ])('refuses to start an arm whose team names %s, and leaves no run', async (_case, armsOf, code, message) => {
    const { fixture } = await twoRevisions(armsOf);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: { code, message } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('refuses to start an arm without team assets on a machine whose user-scope install delivers to its tool', async () => {
    const { fixture } = await twoRevisions(() => 'arms:\n  - name: now\n  - name: bare\n    team: none\n');
    const projects = path.join(fixture.home, '.teamai', 'projects');
    const workspace = fs.readdirSync(projects).map((name) => path.join(projects, name, 'config.yaml')).find((file) => fs.existsSync(file));
    if (workspace === undefined) throw new Error('no workspace config');
    fs.writeFileSync(path.join(fixture.home, '.teamai', 'config.yaml'), fs.readFileSync(workspace, 'utf8').replace(/^scope: .*$/m, 'scope: user').replace(/^(projectRoot|dataHome): .*\n/gm, ''));

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: {
      code: 'arm_team_unclean',
      message: 'Arm "bare" runs without team assets, and this machine\'s user-scope teamai install delivers team assets to claude in your home, where its trials would read them. Start the benchmark on a machine where teamai is installed only in workspace scope.',
    } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);
});
