import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { formatUnknownScorer, loadCachedSuite, syncWorkflowDefinitions } from '../workflow/cache.js';
import { parseSuite } from '../workflow/benchmark/suite.js';

const START = 'a'.repeat(40);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function suiteText(lines: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    schemaVersion: 'v1alpha1',
    name: 'fix',
    repo: 'https://github.com/acme/app.git',
    defaults: '{ tool: claude }',
    arms: '[{ name: baseline }, { name: codex, tool: codex }]',
    repetitions: '1',
    timeout: '1h',
    ...lines,
  };
  return Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}\n`).join('');
}

function taskText(lines: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    schemaVersion: 'v1alpha1',
    title: 'Fix it',
    prompt: 'Make the test pass.',
    startingCommit: START,
    check: '{ run: node test.js, protect: [test.js] }',
    ...lines,
  };
  return Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}\n`).join('');
}

function parse(suite: string, tasks: Record<string, string> = { fix: taskText() }, isAlias = (_model: string) => true) {
  return parseSuite({
    suite: { relativePath: 'benchmarks/fix/suite.yaml', content: suite },
    tasks: Object.entries(tasks).map(([name, content]) => ({ relativePath: `benchmarks/fix/tasks/${name}.yaml`, content })),
    isAlias,
  });
}

describe('parseSuite', () => {
  it('accepts a suite whose arms each change one key', () => {
    const parsed = parse(suiteText({ defaults: '{ tool: claude, model: strong }', arms: '[{ name: baseline }, { name: codex, tool: codex }, { name: fast, model: fast }]' }));

    expect(parsed).toMatchObject({ ok: true, diagnostics: [], warnings: [] });
  });

  it.each([
    ['a suite with 7 arms', suiteText({ arms: `[${['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `{ name: ${name}, tool: ${name} }`).join(', ')}]` }), 'arms', 'a suite has 1 to 6 arms'],
    ['a suite without timeout', suiteText({ timeout: '' }), 'timeout', 'timeout is required: the run\'s timeout, such as 6h'],
    ['an arm that changes tool and model', suiteText({ arms: '[{ name: baseline }, { name: codex, tool: codex, model: fast }]' }), 'arms.1', 'arm "codex" changes tool and model; an arm changes at most one of the defaults keys'],
    ['two arms of one name', suiteText({ arms: '[{ name: baseline }, { name: baseline, tool: codex }]' }), 'arms.1.name', 'arm "baseline" is named twice; arm names are unique'],
    ['two arms that change nothing', suiteText({ arms: '[{ name: baseline }, { name: same, tool: claude }]' }), 'arms.1', 'arm "same" changes none of the defaults keys, and neither does arm "baseline"; at most one arm changes none'],
  ])('reports %s at its suite file', (_rule, suite, field, message) => {
    const parsed = parse(suite);

    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', field, message })]);
  });

  it.each([
    ['a task with both check and successCriteria', taskText({ successCriteria: 'The test passes.' }), 'check', 'a task has exactly one of check and successCriteria'],
    ['a task with an empty protect', taskText({ check: '{ run: node test.js, protect: [] }' }), 'check.protect', 'check.protect lists every path the check reads and the agent must not supply'],
    ['a short startingCommit', taskText({ startingCommit: 'abc1234' }), 'startingCommit', 'must be a full 40-character commit'],
    ['a short source.fix', taskText({ source: '{ platform: claude-code, sessionId: s1, fix: 9a1d4e7 }' }), 'source.fix', 'must be a full 40-character commit'],
    ['check.add without source.fix', taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [test/startup.test.js] }" }), 'check.add', 'check.add writes its files from source.fix; add source.fix, the full commit that brought them'],
    ['check.add outside protect', taskText({ check: "{ run: node test.js, protect: ['test/**'], add: [lib/startup.test.js] }", source: `{ platform: claude-code, sessionId: s1, fix: ${'b'.repeat(40)} }` }), 'check.add.0', 'check.add "lib/startup.test.js" is not under check.protect, so the agent could supply it; add a protect path that covers it'],
    ['a glob in check.add', taskText({ check: "{ run: node test.js, protect: ['test/**'], add: ['test/*.js'] }", source: `{ platform: claude-code, sessionId: s1, fix: ${'b'.repeat(40)} }` }), 'check.add.0', 'must name one file, without glob characters'],
    ...['test/[', 'test/[!'].map((entry) => [
      `an unclosed class ${entry} in check.protect`, taskText({ check: `{ run: node test.js, protect: ['${entry}'], add: ['test/check.js'] }`, source: `{ platform: claude-code, sessionId: s1, fix: ${'b'.repeat(40)} }` }), 'check.protect.0', 'has a [ class with no closing ]',
    ]),
    ...['./test.js', 'lib/../test.js', 'test//check.js', 'test/', 'te\\sts/**'].map((entry) => [
      `a protected path ${entry}`, taskText({ check: `{ run: node test.js, protect: ['${entry}'] }` }), 'check.protect.0', 'must be a path relative to the repo, with no backslash and no ".", ".." or empty segment',
    ]),
  ])('reports %s at its task file and runs the suite without it', (_rule, task, field, message) => {
    const parsed = parse(suiteText(), { bad: task, fix: taskText() });

    expect(parsed).toMatchObject({ ok: true, suite: { tasks: [{ id: 'fix' }] } });
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ file: 'benchmarks/fix/tasks/bad.yaml', field, message })]);
  });

  it('keeps the commit a task names as its fix', () => {
    const fix = 'b'.repeat(40);
    const parsed = parse(suiteText(), { fix: taskText({ source: `{ platform: claude-code, sessionId: s1, fix: ${fix} }` }) });

    expect(parsed).toMatchObject({ ok: true, diagnostics: [], suite: { tasks: [{ id: 'fix', source: { platform: 'claude-code', sessionId: 's1', fix } }] } });
  });

  it.each([
    ['a directory glob', "['test/**']", 'test/startup.test.js'],
    ['a file glob', "['test/*.test.js']", 'test/startup.test.js'],
    ['a directory', '[test]', 'test/unit/startup.test.js'],
    ['the path itself', '[test/startup.test.js]', 'test/startup.test.js'],
  ])('keeps the files check.add writes from the fix, under %s in protect', (_case, protect, added) => {
    const fix = 'b'.repeat(40);
    const parsed = parse(suiteText(), { fix: taskText({ check: `{ run: node test.js, protect: ${protect}, add: [${added}] }`, source: `{ platform: claude-code, sessionId: s1, fix: ${fix} }` }) });

    expect(parsed).toMatchObject({ ok: true, diagnostics: [], suite: { tasks: [{ judge: { kind: 'check', add: { commit: fix, paths: [added] } } }] } });
  });

  it('reports a suite with no valid task', () => {
    const parsed = parse(suiteText(), { bad: taskText({ startingCommit: 'abc1234' }) });

    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', message: 'suite fix has no valid task' }));
  });

  it('warns about a model name in defaults.model while an arm changes the tool, and not about an alias', () => {
    const suite = suiteText({ defaults: '{ tool: claude, model: claude-opus-5-5 }' });

    const named = parse(suite, undefined, () => false);
    const aliased = parse(suite, undefined, (model) => model === 'claude-opus-5-5');

    expect(named).toMatchObject({ ok: true, diagnostics: [] });
    expect(named.ok && named.warnings).toEqual([expect.objectContaining({
      file: 'benchmarks/fix/suite.yaml',
      field: 'defaults.model',
      message: 'defaults.model "claude-opus-5-5" is a model name, not an alias in models/aliases.yaml, and arm "codex" changes the tool; use an alias that names a model for each tool',
    })]);
    expect(aliased.ok && aliased.warnings).toEqual([]);
  });
});

describe('suite sync', () => {
  function team(files: Record<string, string>): LocalConfig {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-suite-'));
    dirs.push(root);
    const repo = path.join(root, 'team-repo');
    write(repo, files);
    return { repo: { localPath: repo, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  }

  function write(repo: string, files: Record<string, string>): void {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
  }

  const suiteAt = (dir: string, name: string): Record<string, string> => ({
    [`benchmarks/${dir}/suite.yaml`]: suiteText({ name }),
    [`benchmarks/${dir}/tasks/fix.yaml`]: taskText(),
  });
  const ROLES = 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], benchmarks: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [], benchmarks: [ops] }\n';

  it('caches a role\'s suites only for that role, and shared suites for everyone', async () => {
    const config = team({ 'manifest/roles.yaml': ROLES, ...suiteAt('dev/dev-fix', 'dev-fix'), ...suiteAt('fix', 'fix') });
    const dev = { ...config, primaryRole: 'dev' };
    const ops = { ...config, primaryRole: 'ops', dataHome: `${config.dataHome}-ops` };

    const devSync = await syncWorkflowDefinitions(dev);
    const opsSync = await syncWorkflowDefinitions(ops);

    expect(devSync.benchmarks.map((suite) => suite.relativePath).sort()).toEqual(['benchmarks/dev/dev-fix/suite.yaml', 'benchmarks/fix/suite.yaml']);
    expect(opsSync.benchmarks.map((suite) => suite.relativePath)).toEqual(['benchmarks/fix/suite.yaml']);
    expect((await loadCachedSuite(dev, 'dev-fix'))?.relativePath).toBe('benchmarks/dev/dev-fix/suite.yaml');
    expect(await loadCachedSuite(ops, 'dev-fix')).toBeNull();
    expect((await loadCachedSuite(ops, 'fix'))?.relativePath).toBe('benchmarks/fix/suite.yaml');
  });

  it('names each scorer a suite lists that this member receives no valid scorer of', async () => {
    const quality = '---\nlabels:\n  - { value: good, score: 1, description: Good. }\n  - { value: bad, score: 0, description: Bad. }\npassingScore: 1\n---\nJudge it.\n';
    const config = team({ 'manifest/roles.yaml': ROLES.replace('benchmarks: [dev]', 'benchmarks: [dev], scorers: [dev]'), 'scorers/dev/quality.md': quality, 'benchmarks/fix/suite.yaml': suiteText({ scorers: '[quality, missing]' }), 'benchmarks/fix/tasks/fix.yaml': taskText() });
    const dev = { ...config, primaryRole: 'dev' };
    const ops = { ...config, primaryRole: 'ops', dataHome: `${config.dataHome}-ops` };

    const devSync = await syncWorkflowDefinitions(dev);
    const opsSync = await syncWorkflowDefinitions(ops);

    const unknown = (scorer: string) => `benchmarks/fix/suite.yaml: suite "fix" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the benchmark does not start without it`;
    expect(devSync.unknownScorers.map(formatUnknownScorer)).toEqual([unknown('missing')]);
    expect(opsSync.unknownScorers.map(formatUnknownScorer)).toEqual([unknown('quality'), unknown('missing')]);
  });

  it('caches neither suite of one name in two active namespaces', async () => {
    const config = { ...team({ 'manifest/roles.yaml': ROLES, ...suiteAt('dev/fix', 'fix'), ...suiteAt('ops/fix', 'fix') }), primaryRole: 'dev', additionalRoles: ['ops'] };

    const result = await syncWorkflowDefinitions(config);

    expect(result.benchmarks).toEqual([]);
    expect(result.invalid).toEqual([expect.objectContaining({
      file: 'benchmarks/dev/fix/suite.yaml',
      code: 'benchmark_namespace_conflict',
      message: 'Suite "fix" is defined in two active namespaces (benchmarks/dev/fix/suite.yaml and benchmarks/ops/fix/suite.yaml); neither runs',
    })]);
    expect(await loadCachedSuite(config, 'fix')).toBeNull();
  });

  it('reports a declared namespace directory that holds suite.yaml itself', async () => {
    const config = { ...team({ 'manifest/roles.yaml': ROLES, 'benchmarks/dev/suite.yaml': suiteText({ name: 'dev' }), 'benchmarks/dev/tasks/fix.yaml': taskText() }), primaryRole: 'dev' };

    const result = await syncWorkflowDefinitions(config);

    expect(result.benchmarks).toEqual([]);
    expect(result.invalid).toEqual([expect.objectContaining({
      file: 'benchmarks/dev/suite.yaml',
      message: 'benchmarks/dev is a namespace; put the suite in benchmarks/dev/<suite>/',
    })]);
  });

  it('keeps the last valid version of a suite with no valid task', async () => {
    const config = team(suiteAt('fix', 'fix'));
    await syncWorkflowDefinitions(config);
    const valid = await loadCachedSuite(config, 'fix');
    write(config.repo.localPath, { 'benchmarks/fix/tasks/fix.yaml': taskText({ startingCommit: 'abc1234' }) });

    const result = await syncWorkflowDefinitions(config);

    expect(result.benchmarks).toEqual([]);
    expect(result.invalid).toContainEqual(expect.objectContaining({ file: 'benchmarks/fix/suite.yaml', message: 'suite fix has no valid task' }));
    expect(valid).not.toBeNull();
    expect(await loadCachedSuite(config, 'fix')).toEqual(valid);
  });
});
