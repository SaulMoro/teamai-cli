import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, syncWorkflowDefinitions } from '../workflow/cache.js';
import { formatDiagnostic } from '../workflow/parse.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';

const dirs: string[] = [];

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cache-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

function writeWorkflow(config: LocalConfig, name: string, body: string): void {
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${name}.yaml`), body);
}

function cacheFiles(config: LocalConfig): string[] {
  const home = config.dataHome ?? '';
  if (!fs.existsSync(home)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(home);
  return files;
}

function cachedText(config: LocalConfig): string {
  return cacheFiles(config).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

const VALID = `schemaVersion: v1alpha1
name: build
description: Compile the project.
steps:
  - id: compile
    command: node compile.js
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow cache', () => {
  it('caches prompt_file bytes and snapshots them into a run', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    const promptFile = path.join(config.repo.localPath, 'prompts', 'review.md');
    fs.writeFileSync(promptFile, 'first prompt');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt_file: prompts/review.md
`);
    await syncWorkflowDefinitions(config);
    const first = await loadCachedWorkflow(config, 'build');
    expect(first?.definition.steps[0]).toMatchObject({ promptFile: 'prompts/review.md', prompt: 'first prompt' });

    const started = await startRun(config, 'build');
    if ('error' in started) throw new Error(started.error.message);
    fs.writeFileSync(promptFile, 'second prompt');
    const changed = await syncWorkflowDefinitions(config);
    const second = await loadCachedWorkflow(config, 'build');
    expect(second?.sourceHash).not.toBe(first?.sourceHash);
    expect(changed.cached).toContain('build');
    fs.rmSync(promptFile);

    const run = await readRun(config, String(started.data.run));
    if (typeof run !== 'object') throw new Error('run was not stored');
    expect(run.definition.steps[0]).toMatchObject({ prompt: 'first prompt', promptFile: 'prompts/review.md' });

    const invalid = await syncWorkflowDefinitions(config);
    expect(invalid.kept).toEqual(['build']);
    expect((await loadCachedWorkflow(config, 'build'))?.definition.steps[0]?.prompt).toBe('second prompt');
  });

  it('rejects symlinked prompt files that escape the team repo', async () => {
    const config = testConfig();
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-prompt.md');
    fs.writeFileSync(outside, 'secret');
    const prompts = path.join(config.repo.localPath, 'prompts');
    fs.mkdirSync(prompts);
    fs.symlinkSync(outside, path.join(prompts, 'prompt.md'));
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt_file: prompts/prompt.md
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid[0]).toMatchObject({
      file: 'workflows/build.yaml',
      line: 6,
      field: 'steps[0].prompt_file',
      message: expect.stringContaining('prompts/'),
    });
  });

  it('does not cache a prompt_file outside prompts/', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, '.git'));
    fs.writeFileSync(path.join(config.repo.localPath, '.git', 'config'), 'oauth2:token@host');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the project.
steps:
  - id: review
    prompt_file: .git/config
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(await loadCachedWorkflow(config, 'build')).toBeNull();
  });

  it('caches a valid workflow and leaves a new invalid file unrunnable', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    writeWorkflow(config, 'broken', 'schemaVersion: v1alpha1\nname: nope\ndescription: x\nsteps: []\n');

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual(['build']);
    expect(result.unrunnable).toEqual(['workflows/broken.yaml']);
    expect(result.invalid.some((diagnostic) => diagnostic.file === 'workflows/broken.yaml' && diagnostic.line > 0)).toBe(true);
    const started = await startRun(config, 'broken');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
    const runnable = await startRun(config, 'build');
    expect(runnable).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('keeps the last valid version when a file becomes invalid', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    const first = await startRun(config, 'build');
    if ('error' in first) throw new Error(first.error.message);
    const before = await readRun(config, String(first.data.run));
    if (typeof before !== 'object') throw new Error('run was not stored');

    writeWorkflow(config, 'build', 'schemaVersion: [\n');
    const again = await syncWorkflowDefinitions(config);

    expect(again.kept).toEqual(['build']);
    expect(again.cached).not.toContain('build');
    expect(again.invalid[0]).toMatchObject({ file: 'workflows/build.yaml', field: '(document)' });
    const second = await startRun(config, 'build');
    if ('error' in second) throw new Error(second.error.message);
    const after = await readRun(config, String(second.data.run));
    if (typeof after !== 'object') throw new Error('run was not stored');
    expect(after.sourceHash).toBe(before.sourceHash);
    expect(after.definition.steps[0]?.command).toBe('node compile.js');
    const leased = await leaseNext(config, after.id, { kind: 'local', machine: 'test', workspace: '/work' });
    expect(leased).toMatchObject({ data: { lease: { command: 'node compile.js' } } });
  });

  it('keeps a runnable cache when dry-run sees a deleted source file', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    fs.rmSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'));

    await syncWorkflowDefinitions(config, { dryRun: true });

    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('does not read a symlinked workflows directory', async () => {
    const config = testConfig();
    const workflows = path.join(config.repo.localPath, 'workflows');
    fs.rmSync(workflows, { recursive: true, force: true });
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-workflows');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'build.yaml'), VALID.replace('command: node compile.js', 'command: node outside-dir.js'));
    fs.symlinkSync(outside, workflows);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(cachedText(config)).not.toContain('outside-dir.js');
    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('does not read or cache a symlinked yaml outside workflows', async () => {
    const config = testConfig();
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-build.yaml');
    const body = VALID.replace('command: node compile.js', 'command: node outside-only.js');
    fs.writeFileSync(outside, body);
    fs.symlinkSync(outside, path.join(config.repo.localPath, 'workflows', 'build.yaml'));

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).not.toContain('build');
    expect(result.invalid).toEqual([]);
    expect(result.unrunnable).toEqual([]);
    expect(cachedText(config)).not.toContain('outside-only.js');
    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('drops the last valid version when a revision uses a key this version does not know', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    expect(await loadCachedWorkflow(config, 'build')).not.toBeNull();

    writeWorkflow(config, 'build', VALID.replace('command: node compile.js', 'command: node compile.js\n    if: success'));
    const synced = await syncWorkflowDefinitions(config);

    expect(synced.unrunnable).toContain('workflows/build.yaml');
    expect(synced.kept).not.toContain('build');
    expect(await loadCachedWorkflow(config, 'build')).toBeNull();
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('keeps each self-mode checkout on its own cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cache-'));
    dirs.push(root);
    const dataHome = path.join(root, 'data');
    const checkout = (name: string, command: string): LocalConfig => {
      const business = path.join(root, name);
      const knowledge = path.join(business, 'knowledge');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      const config: LocalConfig = {
        repo: { localPath: knowledge, remote: 'local', kind: 'self', businessRepoRoot: business },
        username: 'tester',
        scope: 'project',
        additionalRoles: [],
        projectRoot: business,
        dataHome,
      };
      writeWorkflow(config, 'build', VALID.replace('command: node compile.js', `command: ${command}`));
      return config;
    };

    const first = checkout('a', 'echo main-command');
    const second = checkout('b', 'echo second-command');
    await syncWorkflowDefinitions(first);
    await syncWorkflowDefinitions(second);

    const started = await startRun(first, 'build');
    if ('error' in started) throw new Error(started.error.message);
    const leased = await leaseNext(first, String(started.data.run), { kind: 'local', machine: 'test', workspace: '/work' });
    expect(leased).toMatchObject({ data: { lease: { command: 'echo main-command' } } });

    writeWorkflow(first, 'build', 'schemaVersion: [\n');
    const kept = await syncWorkflowDefinitions(first);
    expect(kept.kept).toEqual(['build']);
    const afterInvalid = await startRun(first, 'build');
    if ('error' in afterInvalid) throw new Error(afterInvalid.error.message);
    const stillFirst = await leaseNext(first, String(afterInvalid.data.run), { kind: 'local', machine: 'test', workspace: '/work' });
    expect(stillFirst).toMatchObject({ data: { lease: { command: 'echo main-command' } } });

    fs.rmSync(path.join(second.repo.localPath, 'workflows', 'build.yaml'));
    await syncWorkflowDefinitions(second);
    const afterDelete = await startRun(first, 'build');
    expect(afterDelete).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('reports a step after the first that does not declare needs', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[1].needs": step "test" must declare needs; use needs: [] for another root',
    ]);
  });

  it('reports a needs id that names no step', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    needs: [compile, lint]
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[1].needs": step "test" needs "lint", which is not a step in this workflow',
    ]);
  });

  it('reports a needs cycle with the steps that form it', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Two steps wait for each other.
steps:
  - id: compile
    command: node compile.js
  - id: test
    needs: [compile, publish]
    command: node test.js
  - id: publish
    needs: [test]
    command: node publish.js
  - id: lint
    needs: [lint]
    command: node lint.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[1].needs": step "test" is in a needs cycle: test -> publish -> test',
      'workflows/build.yaml:14: field "steps[3].needs": step "lint" is in a needs cycle: lint -> lint',
    ]);
  });

  it('reports needs that is not a list of step ids', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    needs: compile
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[1].needs": step "test" needs must be a list of step ids',
    ]);
  });

  it('drops a cached copy from before needs when the file still has no needs', async () => {
    const config = testConfig();
    const linear = `schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: node compile.js
  - id: test
    command: node test.js
`;
    // Stand in for the cache an older teamai wrote under the linear rules: same file, no needs.
    writeWorkflow(config, 'build', linear.replace('  - id: test\n', '  - id: test\n    needs: [compile]\n'));
    await syncWorkflowDefinitions(config);
    const cacheFile = cacheFiles(config).find((file) => file.endsWith(`${path.sep}build.json`));
    if (!cacheFile) throw new Error('cache missing');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { definition: { steps: Array<{ needs?: string[] }> } };
    for (const step of cached.definition.steps) delete step.needs;
    fs.writeFileSync(cacheFile, JSON.stringify(cached));
    writeWorkflow(config, 'build', linear);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid).toEqual([expect.objectContaining({ code: 'missing_needs', field: 'steps[1].needs' })]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reports only the broken step when a step numbered 10 or higher is valid', async () => {
    const config = testConfig();
    const steps = Array.from({ length: 12 }, (_, index) => [
      `  - id: s${index}`,
      // Nothing needs the broken step, so the only reference that can go wrong is the one to s10.
      ...(index === 0 ? [] : [`    needs: [${index === 11 ? 's10' : index === 2 ? 's0' : `s${index - 1}`}]`]),
      index === 1 ? "    prompt: ''" : `    command: node s${index}.js`,
    ].join('\n')).join('\n');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Many steps.
steps:
${steps}
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map((diagnostic) => `${diagnostic.field}: ${diagnostic.message}`)).toEqual([
      'steps[1].prompt: prompt must be a non-empty string',
    ]);
  });
});
