/**
 * Real CLI: pull validates the team's benchmark suites per file and caches only the suites a member's namespaces
 * reach, and push --role places a new suite in the role's namespace.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { benchmarkFixture, envelope, fixTask, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

const ROLES = 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], benchmarks: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [], benchmarks: [ops] }\n';

function suite(name: string, lines: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    schemaVersion: 'v1alpha1',
    name,
    repo: 'https://github.com/fixture/app.git',
    defaults: '{ tool: claude }',
    arms: '[{ name: claude }, { name: codex, tool: codex }]',
    repetitions: '1',
    timeout: '10m',
    ...lines,
  };
  return Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}\n`).join('');
}

describe('benchmark suites at pull', () => {
  it('reports each invalid suite and task with its file', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    fixtures.push(fixture);
    const task = fixTask(fixture.startingCommit);
    const sevenArms = `[${['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `{ name: ${name}, tool: ${name} }`).join(', ')}]`;
    fixture.pushTeam({
      'benchmarks/seven/suite.yaml': suite('seven', { arms: sevenArms }),
      'benchmarks/seven/tasks/fix.yaml': task,
      'benchmarks/untimed/suite.yaml': suite('untimed', { timeout: '' }),
      'benchmarks/untimed/tasks/fix.yaml': task,
      'benchmarks/both-keys/suite.yaml': suite('both-keys', { arms: '[{ name: claude }, { name: codex, tool: codex, model: fast }]' }),
      'benchmarks/both-keys/tasks/fix.yaml': task,
      'benchmarks/tasks/suite.yaml': suite('tasks'),
      'benchmarks/tasks/tasks/fix.yaml': task,
      'benchmarks/tasks/tasks/judged-twice.yaml': `${task}successCriteria: The answer is 42.\n`,
      'benchmarks/tasks/tasks/unprotected.yaml': task.replace('protect: [test.js]', 'protect: []'),
      'benchmarks/tasks/tasks/short-commit.yaml': task.replace(fixture.startingCommit, fixture.startingCommit.slice(0, 7)),
    });

    const pulled = await fixture.teamai(['pull']);
    const output = `${pulled.stdout}\n${pulled.stderr}`;

    expect(pulled.code, said(pulled)).toBe(0);
    expect(output).toMatch(/benchmarks\/seven\/suite\.yaml:\d+: field "arms": a suite has 1 to 6 arms/);
    expect(output).toMatch(/benchmarks\/untimed\/suite\.yaml:\d+: field "timeout": timeout is required/);
    expect(output).toMatch(/benchmarks\/both-keys\/suite\.yaml:\d+: field "arms\.1": arm "codex" changes tool and model/);
    expect(output).toMatch(/benchmarks\/tasks\/tasks\/judged-twice\.yaml:\d+: field "check": a task has exactly one of check and successCriteria/);
    expect(output).toMatch(/benchmarks\/tasks\/tasks\/unprotected\.yaml:\d+: field "check\.protect": check\.protect lists every path/);
    expect(output).toMatch(/benchmarks\/tasks\/tasks\/short-commit\.yaml:\d+: field "startingCommit": must be a full 40-character commit/);
  }, 120_000);

  it('reports a check.add entry that names no file of the suite directory with its line, and start refuses the suite', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    fixtures.push(fixture);
    fixture.pushTeam({
      'benchmarks/hidden/suite.yaml': suite('hidden', { arms: '[{ name: claude }]' }),
      'benchmarks/hidden/tasks/fix.yaml': fixTask(fixture.startingCommit).replace('  protect: [test.js]\n', "  protect: ['test/**']\n  add:\n    - from: check-files/missing.test.js\n      to: test/missing.test.js\n"),
    });

    const pulled = await fixture.teamai(['pull']);
    const started = envelope(await fixture.teamai(['workflow', 'start', 'hidden', '--benchmark']));

    expect(pulled.code, said(pulled)).toBe(0);
    expect(`${pulled.stdout}\n${pulled.stderr}`).toContain('benchmarks/hidden/tasks/fix.yaml:9: field "check.add.0.from": "check-files/missing.test.js" is no file or directory of the suite directory; a symlink is not one');
    expect(started.error).toMatchObject({ code: 'benchmark_not_found' });
  }, 120_000);

  it('reports a trial.timeout not shorter than the suite timeout with its line, and start refuses the suite', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    fixtures.push(fixture);
    fixture.pushTeam({
      'benchmarks/capped/suite.yaml': suite('capped', { arms: '[{ name: claude }]', trial: '{ timeout: 1h }' }),
      'benchmarks/capped/tasks/fix.yaml': fixTask(fixture.startingCommit),
    });

    const pulled = await fixture.teamai(['pull']);
    const started = envelope(await fixture.teamai(['workflow', 'start', 'capped', '--benchmark']));

    expect(pulled.code, said(pulled)).toBe(0);
    expect(`${pulled.stdout}\n${pulled.stderr}`).toContain('benchmarks/capped/suite.yaml:8: field "trial.timeout": trial.timeout must be shorter than timeout, which bounds the whole run');
    expect(started.error).toMatchObject({ code: 'benchmark_not_found' });
  }, 120_000);

  it('starts from the last valid version of a suite whose newest revision has no valid task', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    fixtures.push(fixture);
    fixture.pushTeam({
      'benchmarks/kept/suite.yaml': suite('kept', { arms: '[{ name: claude }]' }),
      'benchmarks/kept/tasks/fix.yaml': fixTask(fixture.startingCommit),
    });
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    fixture.pushTeam({ 'benchmarks/kept/tasks/fix.yaml': fixTask('abc1234') });
    const pulled = await fixture.teamai(['pull']);
    const started = envelope(await fixture.teamai(['workflow', 'start', 'kept', '--benchmark']));

    expect(pulled.stdout + pulled.stderr, said(pulled)).toContain('Kept the last valid version of kept');
    expect(started.data?.run, JSON.stringify(started)).toEqual(expect.any(String));
  }, 120_000);

  it('caches a role\'s suite only for members with the role, and push --role places a suite there', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    fixtures.push(fixture);
    fixture.pushTeam({
      'manifest/roles.yaml': ROLES,
      'benchmarks/dev/dev-fix/suite.yaml': suite('dev-fix', { arms: '[{ name: claude }]' }),
      'benchmarks/dev/dev-fix/tasks/fix.yaml': fixTask(fixture.startingCommit),
    });
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    const opsSet = await fixture.teamai(['roles', 'set', 'ops']);
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    const otherRole = envelope(await fixture.teamai(['workflow', 'start', 'dev-fix', '--benchmark']));
    const roleSet = await fixture.teamai(['roles', 'set', 'dev']);
    const pulled = await fixture.teamai(['pull']);
    const withRole = envelope(await fixture.teamai(['workflow', 'start', 'dev-fix', '--benchmark']));
    for (const [file, text] of Object.entries({
      'benchmarks/placed/suite.yaml': suite('placed', { arms: '[{ name: claude }]' }),
      'benchmarks/placed/tasks/fix.yaml': fixTask(fixture.startingCommit),
    })) {
      fs.mkdirSync(path.dirname(path.join(fixture.teamClone, file)), { recursive: true });
      fs.writeFileSync(path.join(fixture.teamClone, file), text);
    }
    const pushed = await fixture.teamai(['push', '--all', '--role', 'dev']);
    const git = (args: string[]): string => execFileSync('git', ['--git-dir', fixture.teamOrigin, ...args], { encoding: 'utf8' }).trim();
    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/']).split('\n').filter(Boolean);

    expect(opsSet.code, said(opsSet)).toBe(0);
    expect(otherRole.error).toMatchObject({ code: 'benchmark_not_found' });
    expect(roleSet.code, said(roleSet)).toBe(0);
    expect(pulled.code, said(pulled)).toBe(0);
    expect(withRole.data?.run, JSON.stringify(withRole)).toEqual(expect.any(String));
    // Provider git pushes the branch and opens no pull request, which push reports as a failure.
    expect(pushed.stdout + pushed.stderr, said(pushed)).toContain('Pushed branch teamai/push/');
    expect(branches.flatMap((branch) => git(['diff', '--name-only', 'main', branch]).split('\n').filter(Boolean)).sort())
      .toEqual(['benchmarks/dev/placed/suite.yaml', 'benchmarks/dev/placed/tasks/fix.yaml']);
  }, 120_000);
});
