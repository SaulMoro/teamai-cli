/**
 * Where a world's command runs: the world's project, as its HOME. Every verb that runs something in a world (teamai, sh,
 * the ledger's uninstall) runs it through `runOn`, which builds its environment, shows and logs its output, and records
 * what a member's own program wrote.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { recordWriters, worldFiles, writeCommandLog, type World } from './world.js';

export type Target = { kind: 'world' };

/** The run id and the target a verb's first argument names. */
export function parseTarget(arg: string | undefined) {
  const target: Target = { kind: 'world' };

  return { runId: arg, target };
}

/** The HOME and project a target's commands run with. */
function placeOf(world: World, target: Target) {
  switch (target.kind) {
    case 'world': return { home: world.home, project: world.project, env: world.env };
    default: {
      const unknown: never = target.kind;

      return unknown;
    }
  }
}

/** What a host process gets to run `argv`: the place's frozen env, or bin/run in a world made before it was kept. */
function hostCommand(world: World, place: ReturnType<typeof placeOf>, argv: readonly string[]) {
  if (place.env === undefined) return { command: path.join(world.bin, 'run'), args: [...argv], env: {} satisfies NodeJS.ProcessEnv, cwd: place.project };
  const [command = 'true', ...args] = argv;

  return { command, args, env: place.env, cwd: place.project };
}

/** Runs `argv` on `target`, its output shown as it comes and kept in the next logs/<n>-<name>.log; answers its exit code. */
export async function runOn(world: World, target: Target, argv: readonly string[]): Promise<{ exit: number; log: string }> {
  if (world.cleanedAt !== undefined) throw new Error(`World ${world.runId} was cleaned up at ${world.cleanedAt}. Make a new one.`);
  const place = placeOf(world, target);
  const before = worldFiles(world);
  const { command, args, env, cwd } = hostCommand(world, place, argv);
  const child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
  let output = '';

  for (const [stream, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      output += chunk;
      to.write(chunk);
    });
  }

  const status = await new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      output += `${error.message}\n`;
      resolve(127);
    });
    child.once('close', (code) => resolve(code));
  });

  const log = writeCommandLog(world, argv, output, status);
  recordWriters(world, argv, before, worldFiles(world));

  return { exit: status ?? 1, log };
}
