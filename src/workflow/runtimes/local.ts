import { spawn } from 'node:child_process';
import { stopProcess } from '@teamai/shared/process-group';
import type { DriverCan } from '../requirements.js';
import { boundedStdout, type OpId, type OpState } from '@teamai/runtime-protocol';
import type { ExecEnd, Lost, StepRuntime } from '@teamai/runtime-protocol/step-runtime';

/** How an exec of this runtime ended: never lost, since it runs in teamai's own process. */
type LocalEnd = Exclude<ExecEnd, Lost>;

/** What `reattach` says of an exec this runtime ended. */
function endedState(op: OpId, end: LocalEnd): OpState {
  switch (end.kind) {
    case 'exited':
      return { op, state: 'exited', code: end.code, stdout: end.stdout };
    case 'cancelled':
      return { op, state: 'cancelled', ...(end.stdout !== undefined && { stdout: end.stdout }) };
    case 'failed':
      return { op, state: 'failed', failure: end.failure };
    default: {
      const unhandled: never = end;

      return unhandled;
    }
  }
}

/**
 * The `local` step runtime, in teamai's process: the place is the worktree as it is on the host, and each `exec` runs
 * there in a process group of its own. It retains outcomes for as long as this process lives, so a teamai started
 * again finds every handle `gone`. It takes no options; `can` is what the caller decided this machine offers.
 */
export function localStepRuntime(can: DriverCan = {}): StepRuntime<DriverCan> {
  const handles = new Map<string, string>();
  const ended = new Map<OpId, { handle: string; end: LocalEnd }>();
  const running = new Map<OpId, { handle: string; end: Promise<ExecEnd>; stop: () => Promise<void>; cancelled: boolean }>();
  const detached = process.platform !== 'win32';

  const exec: StepRuntime<DriverCan>['exec'] = async (request, events) => {
    const retained = ended.get(request.op);

    if (retained) {
      events.onAccepted?.({});

      return retained.end;
    }

    const live = running.get(request.op);

    if (live) {
      events.onAccepted?.({});

      return live.end;
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...request.env, ...request.credentials };

    for (const name of request.unset) delete env[name];
    const [command = '', ...args] = request.argv;
    const child = spawn(command, args, { cwd: request.cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';

    const closed = new Promise<{ code: number; error?: Error }>((resolve) => {
      child.on('error', (error) => resolve({ code: 127, error }));
      child.on('close', (code) => resolve({ code: code ?? 1 }));
    });

    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; events.onOutput?.('stdout', data); });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { events.onOutput?.('stderr', data); });

    const stopGroup = stopProcess(child, closed, detached);

    const entry = {
      handle: request.handle,
      stop: async (): Promise<void> => { await stopGroup(); },
      cancelled: false,
      end: closed.then(({ code, error }): ExecEnd => {
        running.delete(request.op);

        const end: LocalEnd = entry.cancelled ? { kind: 'cancelled' }
          : error ? { kind: 'failed', failure: { code: 'exec_failed', message: `${command} could not be started: ${error.message}` } }
            : { kind: 'exited', code, stdout };

        // Kept within protocol 1's bound for as long as this process lives; the exec's caller gets the whole stdout.
        ended.set(request.op, { handle: request.handle, end: end.kind === 'exited' ? { ...end, stdout: boundedStdout(end.stdout) } : end });

        return end;
      }),
    };

    running.set(request.op, entry);
    events.onAccepted?.({});

    return entry.end;
  };

  const opsOf = (handle: string): OpState[] => [
    ...[...running].flatMap(([op, live]): OpState[] => (live.handle === handle ? [{ op, state: 'running' }] : [])),
    ...[...ended].flatMap(([op, { handle: of, end }]): OpState[] => (of === handle ? [endedState(op, end)] : [])),
  ];

  return {
    name: 'local',

    async init({ options }) {
      const [key] = Object.keys(options);

      return key === undefined ? { ok: true, can, launchesAgents: false } : { ok: false, failure: { code: 'bad_option', key, message: `The local runtime takes no options, and was given "${key}".` } };
    },

    async open(request, onAccepted) {
      const key = `${request.run}/${request.attempt}`;
      const handle = handles.get(key) ?? `local-${request.run}-${request.attempt}`;
      handles.set(key, handle);
      await onAccepted(handle);

      return { kind: 'ready', handle };
    },

    exec,

    async prompt() {
      return { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The local runtime launches a prompt\'s tool as an exec of its argv, never through prompt.' } };
    },

    async cancel(op) {
      const live = running.get(op);

      if (!live) return;
      live.cancelled = true;
      await live.stop();
    },

    async collect() {
      return { ok: true };
    },

    async reattach(handle) {
      return [...handles.values()].includes(handle) ? { kind: 'alive', ops: opsOf(handle) } : { kind: 'gone' };
    },

    async close(handle) {
      for (const [key, open] of handles) if (open === handle) handles.delete(key);

      for (const [op, done] of ended) if (done.handle === handle) ended.delete(op);

      return { ok: true };
    },

    async dispose() {},
  };
}
