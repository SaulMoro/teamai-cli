import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import { buildPluginSource } from '../../opencode-hooks.js';

/** One `teamai hook-dispatch` the generated plugin spawned: its argv and the JSON it wrote on STDIN. */
export interface PluginDispatch {
  args: string[];
  payload: Record<string, unknown>;
}

type Hooks = Record<string, (...args: unknown[]) => Promise<void>>;
export interface PluginDefinition {
  id: string;
  server: (ctx: unknown) => Promise<Hooks>;
  setup: (ctx: unknown) => Promise<(() => void | Promise<void>) | void>;
}

/** Compile the original ESM exports; mock only the subprocess I/O boundary. */
export function loadPluginDefinition(source: string, globals: Record<string, unknown> = {}): PluginDefinition {
  const module = { exports: {} as { default: PluginDefinition } };
  const executable = transformSync(source.replaceAll("await import('node:child_process')", 'globalThis.__childProcess'), { format: 'cjs' }).code;
  vm.runInNewContext(executable, { module, exports: module.exports, process: { platform: 'linux' }, AbortController, ...globals });
  return module.exports.default;
}

/**
 * The generated OpenCode plugin, evaluated in a `vm` context whose
 * `child_process.spawn` records each dispatch instead of running `teamai`.
 * `dispatches` fills as the host calls the returned hooks.
 */
function capturePlugin(source: string, globals: Record<string, unknown> = {}) {
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
  return { plugin: loadPluginDefinition(source, { __childProcess: { spawn }, ...globals }), dispatches };
}

export async function loadOpencodePlugin(ctx: { directory?: string; worktree?: string } = {}) {
  const { plugin, dispatches } = capturePlugin(buildPluginSource());
  return { hooks: await plugin.server(ctx), dispatches };
}

/** V2's public registration/stream boundaries, with abortable event delivery. */
export async function loadV2Plugin(source = buildPluginSource(), globals: Record<string, unknown> = {}) {
  const { plugin, dispatches } = capturePlugin(source, globals);
  const callbacks: Record<string, (...args: unknown[]) => Promise<void>> = {};
  const disposed: string[] = [];
  let signal: AbortSignal;
  let wake: (() => void) | undefined;
  const queue: Array<{ event: unknown; done: () => void }> = [];
  const register = (domain: string) => async (name: string, callback: (...args: unknown[]) => Promise<void>) => {
    const key = `${domain}.${name}`;
    callbacks[key] = callback;
    return { dispose: async () => { disposed.push(key); delete callbacks[key]; } };
  };
  const location = { directory: '/work/proj' };
  const cleanup = await plugin.setup({
    location,
    session: { hook: register('session') },
    tool: { hook: register('tool') },
    event: { subscribe: (options: { signal: AbortSignal }) => {
      signal = options.signal;
      signal.addEventListener('abort', () => wake?.(), { once: true });
      return (async function* () {
        while (!signal.aborted) {
          if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
          if (signal.aborted) break;
          const next = queue.shift()!;
          yield next.event;
          next.done();
        }
      })();
    } },
  });
  return {
    plugin, dispatches, callbacks, disposed, cleanup,
    aborted: () => signal?.aborted,
    emit: (type: string, data: unknown, eventLocation: unknown = location) => new Promise<void>((done) => {
      queue.push({ event: { type, data, location: eventLocation }, done }); wake?.();
    }),
  };
}
