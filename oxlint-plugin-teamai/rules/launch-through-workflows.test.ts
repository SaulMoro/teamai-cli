import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ruleHarness } from '../test/harness.ts';
import { ALLOWED, LAUNCHERS } from './launch-through-workflows.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/launch-through-workflows', { filename: 'src/feature.ts' });

describe('teamai/launch-through-workflows', () => {
  rule.invalid('rejects a static import of the AI call', `import { createToolCaller } from './workflow/runtimes/tool-caller.js';`, (output) => {
    expect(output).toContain('docs/designs/ai-through-workflows.md');
  });
  rule.invalid('rejects a dynamic import of the AI call', `const { createToolCaller } = await import('./workflow/runtimes/tool-caller.js');`);
  rule.invalid('rejects a re-export of the AI call', `export { createToolCaller } from './workflow/runtimes/tool-caller.js';`);
  rule.invalid('rejects a confined launch', `import { runConfined } from './workflow/confined-launch.js';`);
  rule.invalid('rejects a renamed confined launch', `import { runConfined as launch } from './workflow/confined-launch.js';`);
  rule.invalid('rejects a dynamic import of the confined tools, which may launch one', `const confined = await import('./workflow/confined-launch.js');`);
  rule.valid('allows what the confined tools of this machine can do', `import { installedConfinedTools, type ConfinedResult } from './workflow/confined-launch.js';`);
  rule.valid('allows the tool a member names and the error a bad one raises', `import { CallError, isOverrideInvalid, memberTools } from './tool-launch/member-tools.js';`);
  rule.valid('allows the types of an AI call', `import type { CallResult } from './workflow/runtimes/tool-caller.js';`);
  rule.invalid('rejects the launch library from a scorer', `import { callLaunch } from '@teamai/tool-launch/call-launch';`, undefined, { filename: 'src/scorers/x.ts' });
  rule.invalid('rejects the tools runtime\'s answer launch outside a workflow driver', `import { answerLaunch } from '@teamai/runtime-tools/answer';`, undefined, { filename: 'src/x.ts' });
  rule.invalid('rejects the tools runtime itself outside a workflow driver', `import { toolsStepRuntime } from '@teamai/runtime-tools';`, undefined, { filename: 'src/x.ts' });
  rule.invalid('rejects a launcher from a folder no one has listed yet', `import { runTool } from '@teamai/runtime-tools/headless';`, undefined, { filename: 'src/brand-new/x.ts' });
  rule.invalid('rejects the launch library from the folder that held the launcher', `import { runStepLaunch } from '@teamai/tool-launch/run-step-launch';`, undefined, { filename: 'src/tool-launch/x.ts' });
  rule.valid('allows the sandbox runtime the launch library', `import { runStepLaunch } from '@teamai/tool-launch/run-step-launch';`, { filename: 'packages/runtime-sandbox/src/prompt.ts' });
  rule.valid('allows the tools runtime the launch library', `import { callLaunch } from '@teamai/tool-launch/call-launch';`, { filename: 'packages/runtime-tools/src/answer.ts' });
  rule.valid('allows a workflow driver to launch', `import { runConfined } from '../../confined-launch.js'; import { answerLaunch } from '@teamai/runtime-tools/answer';`, { filename: 'src/workflow/drivers/local/feature.ts' });
  rule.valid('allows the types of the launch library and of the tools runtime anywhere', `import type { CallEnd } from '@teamai/tool-launch/call-launch'; import type { StepLauncher } from '@teamai/runtime-tools';`, { filename: 'src/scorers/x.ts' });
  rule.valid('allows other workspace packages', `import { spawnCommand } from '@teamai/tool-core/exec';`);
  rule.invalid('rejects a print-mode call of a tool binary', `spawn('claude', ['-p', prompt]);`);
  rule.invalid('rejects a call of a tool binary through any process helper', `await execCommand('codex', ['exec', prompt], { cwd });`);
  rule.invalid('rejects a tool binary whose arguments it cannot read', `crossSpawn('cursor-agent', args);`);
  rule.invalid('rejects a tool binary given a subcommand it may not run', `crossSpawn('opencode', ['run', prompt]);`);
  rule.valid('allows asking a tool binary its version', `probeBinary('claude', ['--version'], executor); probeBinary('opencode');`, { filename: 'src/pkg/env-detect.ts' });
  rule.valid('allows serving and reading opencode sessions', `crossSpawn('opencode', ['serve', '--port', port]); execCommand('opencode', ['session', 'list']);`);
  rule.valid('allows a call that names a tool and starts no process', `toolHome('agy'); reconcileHooks('claude', []);`);
  rule.invalid('rejects a tool binary run through a method of a process helper', `await this.execute('claude', ['-p', prompt]);`);
  rule.valid('allows a workflow driver to run a tool binary', `spawn('claude', ['-p', prompt]);`, { filename: 'src/workflow/drivers/local/feature.ts' });
  rule.valid('allows tests to drive the launcher', `vi.mock('../workflow/runtimes/tool-caller.js'); import { createToolCaller } from '../workflow/runtimes/tool-caller.js';`, { filename: 'src/__tests__/feature.test.ts' });
});

/** The source files of this checkout the rule reads: src/ and every package's src/, tests left out. */
function sources(): string[] {
  const roots = ['src', ...fs.readdirSync(path.join(REPO, 'packages')).map((folder) => path.join('packages', folder, 'src'))];

  return roots.filter((root) => fs.existsSync(path.join(REPO, root))).flatMap((root) => fs.readdirSync(path.join(REPO, root), { recursive: true, encoding: 'utf8' })
    .map((entry) => path.posix.join(root, entry.split(path.sep).join('/')))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.includes('__tests__/')));
}

describe('what the rule lists', () => {
  it('names only folders that exist, so an emptied folder keeps no exemption', () => {
    for (const folder of ALLOWED) expect(fs.statSync(path.join(REPO, folder)).isDirectory(), folder).toBe(true);
  });

  it('names only launchers that resolve, a module to its file and a package to its manifest', () => {
    for (const launcher of Object.keys(LAUNCHERS)) {
      const file = launcher.startsWith('@teamai/') ? path.join(REPO, 'packages', launcher.slice('@teamai/'.length), 'package.json') : path.join(REPO, launcher);

      expect(fs.existsSync(file), launcher).toBe(true);
    }
  });

  it('matches every launcher an import in this checkout reaches, each from inside the folders that may launch', () => {
    const IMPORT = /^\s*(?:import|export)\s+(?!type\b)([^'"]*?)from\s+'([^']+)'/gmu;
    const reached = sources().flatMap((file) => [...fs.readFileSync(path.join(REPO, file), 'utf8').matchAll(IMPORT)].flatMap(([, clause = '', specifier = '']) => {
      const to = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/u, '.ts') : specifier.split('/').slice(0, 2).join('/');

      if (!(to in LAUNCHERS)) return [];
      const names = LAUNCHERS[to];

      // A module that launches only through some of its names is reached by an import of one of them.
      return names === undefined || names.some((name) => (name === '*' ? clause.includes('* as') : new RegExp(`\\b${name}\\b`, 'u').test(clause))) ? [{ file, to }] : [];
    }));

    // Each launcher is imported somewhere, so none is a stale entry the rule would never match.
    expect(new Set(reached.map(({ to }) => to))).toEqual(new Set(Object.keys(LAUNCHERS)));
    expect(reached.length).toBeGreaterThan(10);
    expect(reached.filter(({ file }) => !ALLOWED.some((folder) => file.startsWith(folder)) && !file.startsWith('packages/tool-launch/'))).toEqual([]);
  });
});
