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

    writeWorkflow(config, 'build', VALID.replace('command: node compile.js', 'command: node compile.js\n    for_each: items'));
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

  it('reports an end that is not declared in ends', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: compile
    command: node compile.js
    end: dropped
  - id: stop
    needs: []
    end: droped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:12: field "steps[1].end": step "stop" ends with "droped", which is not declared in ends',
    ]);
  });

  it('reports an end in a workflow that declares no ends', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].end": step "stop" ends with "dropped", but the workflow declares no ends',
    ]);
  });

  it('reports a declared end that no step reaches', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
  stuck: failed
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "ends.stuck": end "stuck" is declared in ends, but no step ends with it',
    ]);
  });

  it('reports a step that needs a step that only ends the workflow', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
  - id: test
    needs: [compile, stop]
    command: node test.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:13: field "steps[2].needs": step "test" needs "stop", which only ends the workflow, so "test" can never run',
    ]);
  });

  it('reports output on a step that only ends the workflow', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: stop
    end: dropped
    output: string
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[0].output": step "stop" has no action, so it carries only id, needs, if, and end',
    ]);
  });

  it('reports an end whose outcome is not succeeded or failed', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: done
steps:
  - id: stop
    end: dropped
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "ends.dropped": ends must map each end name to succeeded or failed',
    ]);
  });

  it('keeps the last valid version when a revision ends with an undeclared end', async () => {
    const config = testConfig();
    const valid = `schemaVersion: v1alpha1
name: build
description: Stop early.
ends:
  dropped: succeeded
steps:
  - id: compile
    command: node compile.js
  - id: stop
    needs: [compile]
    end: dropped
`;
    writeWorkflow(config, 'build', valid);
    await syncWorkflowDefinitions(config);
    writeWorkflow(config, 'build', valid.replace('end: dropped', 'end: droped'));

    const result = await syncWorkflowDefinitions(config);

    expect(result.kept).toEqual(['build']);
    expect(await loadCachedWorkflow(config, 'build')).toMatchObject({
      definition: { ends: { dropped: 'succeeded' }, steps: [{ id: 'compile' }, { id: 'stop', end: 'dropped' }] },
    });
  });
  it('reports an if that does not parse with its column', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue when the check fails.
steps:
  - id: check
    command: node check.js
  - id: label
    needs: [check]
    if: steps.check.outcome = 'failed'
    command: node label.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].if": step "label" if does not parse at column 21: unexpected "="',
    ]);
  });

  it('reports an if that reads a step it does not need', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue when the check fails.
steps:
  - id: check
    command: node check.js
  - id: docs
    needs: []
    command: node docs.js
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed' && steps.docs.outcome == 'success' || steps.nope.end == null
    command: node label.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:12: field "steps[2].if": step "label" if reads steps.docs, which is not a step it needs, directly or through its needs',
      'workflows/build.yaml:12: field "steps[2].if": step "label" if reads steps.nope, which is not a step it needs, directly or through its needs',
    ]);
  });

  it('reports an if that reads an output field the step does not declare', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix what the review asks for.
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
      notes:
        summary: string
  - id: free
    needs: []
    command: node free.js
  - id: fix
    needs: [review, free]
    if: steps.review.outputs.verdcit == 'fix' || steps.review.outputs.notes.summary == '' || steps.review.outputs.verdict.text || steps.free.outputs.anything
    command: node fix.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:16: field "steps[2].if": step "fix" if reads steps.review.outputs.verdcit, which is not in the output step "review" declares',
      'workflows/build.yaml:16: field "steps[2].if": step "fix" if reads steps.review.outputs.verdict.text, which is not in the output step "review" declares',
    ]);
  });

  it('reports a literally false if and drops the version that would still run the step', async () => {
    const config = testConfig();
    const body = `schemaVersion: v1alpha1
name: build
description: Publish after the build.
steps:
  - id: compile
    command: node compile.js
  - id: publish
    needs: [compile]
    command: node publish.js
  - id: notify
    needs: [compile]
    command: node notify.js
`;
    writeWorkflow(config, 'build', body);
    await syncWorkflowDefinitions(config);
    writeWorkflow(config, 'build', body
      .replace('command: node publish.js', 'if: false\n    command: node publish.js')
      .replace('command: node notify.js', "if: \"!(1 == 1) || ''\"\n    command: node notify.js"));

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].if": step "publish" if is always false, so the step never runs',
      'workflows/build.yaml:13: field "steps[2].if": step "notify" if is always false, so the step never runs',
    ]);
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reports a template in a command and points to env', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue.
inputs:
  title: string
steps:
  - id: label
    command: node label.js "{{inputs.title}}"
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:8: field "steps[0].command": step "label" command contains {{inputs.title}}; command strings are not templated; pass the value through env:',
    ]);
  });

  it('reports env on a step that does not run a command', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the change.
steps:
  - id: review
    prompt: Review the change.
    env:
      TITLE: fixed
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].env": step "review" env is only allowed on a command step',
    ]);
  });

  it('reports an env name that is not a valid variable name', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Label the issue.
steps:
  - id: label
    command: node label.js
    env:
      GOOD_1: fine
      1BAD: one
      BAD-NAME: two
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[0].env.1BAD": step "label" env name "1BAD" must match ^[A-Za-z_][A-Za-z0-9_]*$',
      'workflows/build.yaml:10: field "steps[0].env.BAD-NAME": step "label" env name "BAD-NAME" must match ^[A-Za-z_][A-Za-z0-9_]*$',
    ]);
  });

  it('reports a template in a prompt or env that reads a bad path', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix the issue.
inputs:
  title: string
steps:
  - id: plan
    command: node plan.js
    output:
      task: string
  - id: free
    needs: []
    command: node free.js
  - id: fix
    needs: [plan]
    prompt: "{{ inputs.titel }} {{ steps.plan.outputs.tsk }} {{ steps.free.outcome }} {{ inputs.title }}"
  - id: label
    needs: [plan]
    command: node label.js
    env:
      TASK: "{{ steps.plan.outputs.task }}"
      FREE: "{{ steps.free.outputs.y }}"
      SAME: "{{ inputs.title == 'x' }}"
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:23: field "steps[3].env.SAME": step "label" env.SAME template {{ inputs.title == \'x\' }}: a template reads one path',
      'workflows/build.yaml:16: field "steps[2].prompt": step "fix" prompt reads inputs.titel, which is not an input the workflow declares',
      'workflows/build.yaml:16: field "steps[2].prompt": step "fix" prompt reads steps.plan.outputs.tsk, which is not in the output step "plan" declares',
      'workflows/build.yaml:16: field "steps[2].prompt": step "fix" prompt reads steps.free, which is not a step it needs, directly or through its needs',
      'workflows/build.yaml:22: field "steps[3].env.FREE": step "label" env.FREE reads steps.free, which is not a step it needs, directly or through its needs',
    ]);
    expect(result.invalid.map((diagnostic) => diagnostic.code)).toEqual(Array(5).fill('bad_template'));
  });

  it('reports a bad template in prompt_file text and drops the version that rendered it as text', async () => {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'prompts'));
    const promptFile = path.join(config.repo.localPath, 'prompts', 'review.md');
    fs.writeFileSync(promptFile, 'Review the issue.');
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Review the issue.
steps:
  - id: review
    prompt_file: prompts/review.md
`);
    await syncWorkflowDefinitions(config);
    // Stand in for the cache an older teamai wrote: the braces reached the agent as written.
    const cacheFile = cacheFiles(config).find((file) => file.endsWith(`${path.sep}build.json`));
    if (!cacheFile) throw new Error('cache missing');
    const text = 'Review issue {{ inputs.issue }}.';
    fs.writeFileSync(cacheFile, fs.readFileSync(cacheFile, 'utf8').replace('Review the issue.', text));
    fs.writeFileSync(promptFile, text);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "steps[0].prompt_file": step "review" prompt_file reads inputs.issue, which is not an input the workflow declares',
    ]);
    expect(result.invalid[0]?.code).toBe('bad_template');
    expect(result.unrunnable).toEqual(['workflows/build.yaml']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reports an if that reads an input the workflow does not declare', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Ship when asked.
inputs:
  ship: boolean
  issue:
    number: number
steps:
  - id: build
    command: node build.js
  - id: ship
    needs: [build]
    if: inputs.shipp || inputs.issue.numbr == 1 || inputs.issue.number == 1 || inputs.ship
    command: node ship.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:13: field "steps[1].if": step "ship" if reads inputs.shipp, which is not an input the workflow declares',
      'workflows/build.yaml:13: field "steps[1].if": step "ship" if reads inputs.issue.numbr, which is not an input the workflow declares',
    ]);
  });

  it('reports a dot in a step id or a field name and drops the version that has one', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Compile the project.
inputs:
  issue.number: number
steps:
  - id: compile.all
    command: node compile.js
    output:
      result.ok: boolean
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "inputs": field name "issue.number" cannot contain "."; a path reads "." as a separator',
      'workflows/build.yaml:7: field "steps[0].id": step id "compile.all" cannot contain "."; a path reads "." as a separator',
      'workflows/build.yaml:10: field "steps[0].output": field name "result.ok" cannot contain "."; a path reads "." as a separator',
    ]);
    expect(result.invalid.map((diagnostic) => diagnostic.code)).toEqual(['dotted_name', 'dotted_name', 'dotted_name']);
    expect(result.kept).toEqual([]);
    expect(await startRun(config, 'build')).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('reads env numbers and booleans as text and reports a value that is not a scalar', async () => {
    const config = testConfig();
    const body = `schemaVersion: v1alpha1
name: build
description: Label the issue.
steps:
  - id: label
    command: node label.js
    env:
      RETRIES: 3
      DRY: true
`;
    writeWorkflow(config, 'build', body);
    await syncWorkflowDefinitions(config);
    expect((await loadCachedWorkflow(config, 'build'))?.definition.steps[0]?.env).toEqual({ RETRIES: '3', DRY: 'true' });
    writeWorkflow(config, 'build', `${body}      EMPTY:
      LIST: [a]
      MAP: { a: 1 }
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:10: field "steps[0].env.EMPTY": step "label" env.EMPTY must be a string, number, or boolean',
      'workflows/build.yaml:11: field "steps[0].env.LIST": step "label" env.LIST must be a string, number, or boolean',
      'workflows/build.yaml:12: field "steps[0].env.MAP": step "label" env.MAP must be a string, number, or boolean',
    ]);
  });

  it('reports only a malformed inputs header, not every read of it', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Fix the issue.
inputs:
  issue: integer
steps:
  - id: fix
    if: inputs.issue == 1
    prompt: "Fix {{ inputs.issue }}."
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "inputs.issue": unknown output type "integer"',
    ]);
  });

  it('reports outputs that are not paths reading a step of the workflow, or read an undeclared field', async () => {
    const config = testConfig();
    writeWorkflow(config, 'check', `schemaVersion: v1alpha1
name: check
description: Classify the issue.
outputs:
  verdict: steps.classify.outputs.verdcit
  missing: steps.clasify.outputs.verdict
  text: "{{ steps.classify.outputs.verdict }}"
  input: inputs.issue
  ok: steps.classify.outputs.verdict
  outcome: steps.classify.outcome
steps:
  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
`);
    writeWorkflow(config, 'list', `schemaVersion: v1alpha1
name: list
description: Outputs as a list.
outputs: [steps.classify.outputs.verdict]
steps:
  - id: classify
    command: node classify.js
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/check.yaml', 'workflows/list.yaml']);
    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/check.yaml:7: field "outputs.text": output "text" must be a path that reads a step, such as steps.<id>.outputs.<field>',
      'workflows/check.yaml:8: field "outputs.input": output "input" must be a path that reads a step, such as steps.<id>.outputs.<field>',
      'workflows/check.yaml:5: field "outputs.verdict": output "verdict" reads steps.classify.outputs.verdcit, which is not in the output step "classify" declares',
      'workflows/check.yaml:6: field "outputs.missing": output "missing" reads steps.clasify, which is not a step in this workflow',
      'workflows/list.yaml:4: field "outputs": outputs must map each name to a path such as steps.<id>.outputs.<field>',
    ]);
  });

  it('reports a workflow step that names no workflow, carries agent or output, or passes with values it may not read', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', `schemaVersion: v1alpha1
name: build
description: Run sub-workflows.
steps:
  - id: plan
    command: node plan.js
    with:
      issue: 1
  - id: check
    needs: [plan]
    workflow: "../check"
  - id: review
    needs: [plan]
    workflow: check
    agent: reviewer
    output:
      ok: boolean
  - id: list
    needs: [plan]
    workflow: check
    with: [1]
  - id: read
    needs: []
    workflow: check
    with:
      task: "{{ steps.plan.outputs.task }}"
      deep:
        title: "{{ inputs.titel }}"
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.invalid.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].with": step "plan" with is only allowed on a workflow step',
      'workflows/build.yaml:11: field "steps[1].workflow": step "check" workflow must be the name of a workflow in workflows/',
      'workflows/build.yaml:15: field "steps[2].agent": agent is only allowed on a prompt or prompt_file step',
      'workflows/build.yaml:16: field "steps[2].output": step "review" output is not allowed on a workflow step; declare outputs in the workflow it runs',
      'workflows/build.yaml:21: field "steps[3].with": step "list" with must map the workflow\'s inputs to values',
      'workflows/build.yaml:26: field "steps[4].with.task": step "read" with.task reads steps.plan, which is not a step it needs, directly or through its needs',
      'workflows/build.yaml:28: field "steps[4].with.deep": step "read" with.deep reads inputs.titel, which is not an input the workflow declares',
    ]);
  });
});
