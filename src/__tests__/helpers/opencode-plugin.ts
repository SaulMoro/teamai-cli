import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { buildPluginSource } from '../../opencode-hooks.js';

/** One `teamai hook-dispatch` the generated plugin spawned: its argv and the JSON it wrote on STDIN. */
export interface PluginDispatch {
  args: string[];
  payload: Record<string, unknown>;
}

/**
 * The generated OpenCode plugin, evaluated in a `vm` context whose
 * `child_process.spawn` records each dispatch instead of running `teamai`.
 * `dispatches` fills as the host calls the returned hooks.
 */
export async function loadOpencodePlugin(ctx: { directory?: string; worktree?: string } = {}): Promise<{
  hooks: Record<string, (...args: unknown[]) => Promise<void>>;
  dispatches: PluginDispatch[];
}> {
  const dispatches: PluginDispatch[] = [];
  const spawn = (_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: { write: (s: string) => void; end: () => void } };
    let stdin = '';
    child.stdin = {
      write: (s: string) => { stdin += s; },
      end: () => {
        dispatches.push({ args, payload: JSON.parse(stdin) as Record<string, unknown> });
        void Promise.resolve().then(() => child.emit('close', 0));
      },
    };
    return child;
  };
  const executable = buildPluginSource()
    .replace('await import(\'node:child_process\')', 'globalThis.__childProcess')
    .replace('export const TeamaiHooks =', 'globalThis.TeamaiHooks =');
  const context = { __childProcess: { spawn }, process: { platform: 'linux' } } as Record<string, unknown>;
  vm.runInNewContext(executable, context);
  const hooks = await (context.TeamaiHooks as (c: unknown) => Promise<Record<string, (...args: unknown[]) => Promise<void>>>)(ctx);
  return { hooks, dispatches };
}
