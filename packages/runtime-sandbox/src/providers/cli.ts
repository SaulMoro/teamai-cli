import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PlaceView, RuntimeFailure } from '@teamai/runtime-protocol';

// ─── What every bind-mount provider shares: its CLI, and the place view as mounts ───
//
//  docker, podman and sbx are each one CLI the runtime runs once per step of its work, found on teamai's PATH, and each
//  mounts the place view at its host paths with the access the view gives each path.
//

export type Ran = { kind: 'ran'; code: number; stdout: string; stderr: string } | { kind: 'unstartable'; message: string };

export interface Cli {
  /** Runs the CLI once with `args`, on `env` (teamai's own environment unless given), streaming its output. */
  run(args: string[], options?: { env?: NodeJS.ProcessEnv; onOutput?: (stream: 'stdout' | 'stderr', data: string) => void }): Promise<Ran>;
  /** What the CLI said when it could not do something: its last stderr line, or why it could not start. */
  why(ran: Ran): string;
}

/**
 * The CLI `name` as teamai's PATH finds it. spawn looks a bare name up on the env it is given, and an exec's env may
 * carry the PATH the step wants inside the sandbox, so the path is resolved once, on teamai's.
 */
export function cliOf({ name, env, notInstalled }: { name: string; env: NodeJS.ProcessEnv; notInstalled: string }): Cli {
  const executable = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '').map((dir) => path.join(dir, name)).find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return true;
    } catch {
      return false;
    }
  }) ?? name;

  return {
    run: (args, { env: runEnv = env, onOutput } = {}) => new Promise((resolve) => {
      const child = spawn(executable, args, { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; onOutput?.('stdout', data); });
      child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr = `${stderr}${data}`.slice(-8000); onOutput?.('stderr', data); });
      // A CLI that cannot start never closes: ENOENT is a missing CLI, anything else (EACCES) is named as it is.
      child.on('error', (error) => resolve({ kind: 'unstartable', message: 'code' in error && error.code === 'ENOENT' ? notInstalled : `${name} could not be started: ${error.message}` }));
      child.on('close', (code, signal) => resolve({ kind: 'ran', code: code ?? (signal === 'SIGKILL' ? 137 : 143), stdout, stderr }));
    }),
    why: (ran) => (ran.kind === 'unstartable' ? ran.message : ran.stderr.trim().split('\n').at(-1) ?? ''),
  };
}

/** One path of the place view and the access the sandbox gets to it. */
export interface Mount {
  at: string;
  mode: 'rw' | 'ro';
}

/**
 * Every path of `view`, each at its host path: the worktree, the result directory, the run directory and the tool
 * homes read-write, the git paths read-only. A writable path the CLI would create is created here first, so the member
 * owns it, not root. A path with ":" or "," is refused: neither `-v` nor sbx's `PATH:ro` can carry it.
 */
export function mountsOf(name: string, view: PlaceView): { ok: true; mounts: Mount[] } | { ok: false; failure: RuntimeFailure } {
  const writable = [view.worktree, view.result, view.runDir, ...Object.values(view.toolHome)];
  const mounts: Mount[] = [...writable.map((at) => ({ at, mode: 'rw' as const })), ...view.readonly.map((at) => ({ at, mode: 'ro' as const }))];
  const refused = mounts.map(({ at }) => unmountable(name, at)).find((failure) => failure !== undefined);

  if (refused) return { ok: false, failure: refused };

  for (const { at, mode } of mounts) if (mode === 'rw') fs.mkdirSync(at, { recursive: true });

  return { ok: true, mounts };
}

/** Why `name` cannot mount `at`, when a mount argument cannot carry it. */
export function unmountable(name: string, at: string): RuntimeFailure | undefined {
  return /[:,]/.test(at) ? { code: 'sandbox_failed', message: `${name} cannot mount ${at}: a path with ":" or "," cannot be mounted. Move the checkout to a path without them.` } : undefined;
}
