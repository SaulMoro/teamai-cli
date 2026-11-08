import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/spawn-command', { filename: 'src/tool-launch/run.ts' });

rule.valid('allows tool-core\'s exec module to start processes through cross-spawn', `
import spawn from 'cross-spawn';
export const start = (command: string) => spawn(command, []);
`, { filename: 'packages/tool-core/src/exec.ts' });

rule.valid('allows a test to mock cross-spawn', `
import { vi } from 'vitest';
vi.mock('cross-spawn', () => ({ default: vi.fn() }));
import crossSpawn from 'cross-spawn';
export const spawned = crossSpawn;
`, { filename: 'src/__tests__/tool-launch-run.test.ts' });

rule.valid('allows starting a process through spawnCommand', `
import { spawnCommand } from '@teamai/tool-core/exec';
export const start = (command: string) => spawnCommand(command, [], {});
`);

rule.invalid('rejects importing cross-spawn in teamai\'s source', `
import crossSpawn from 'cross-spawn';
export const start = (command: string) => crossSpawn(command, []);
`);

rule.invalid('rejects importing cross-spawn in a workspace package other than tool-core\'s exec module', `
import spawn from 'cross-spawn';
export const start = (command: string) => spawn(command, []);
`, undefined, { filename: 'packages/runtime-paseo/src/daemon/sign-in.ts' });

rule.invalid('rejects loading cross-spawn at run time', `
export const load = () => import('cross-spawn');
`);

rule.invalid('rejects requiring cross-spawn', `
export const spawn = require('cross-spawn');
`, undefined, { filename: 'src/codex-trust.ts' });
