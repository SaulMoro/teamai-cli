/**
 * Where a world's command runs: the world's project, as its HOME. Every verb that runs something in a world (teamai, sh,
 * the ledger's uninstall) runs it through `runOn`, which builds its environment, shows and logs its output, and records
 * what a member's own program wrote.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { lineRedactor, worldRedactor } from './secrets.js';
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

/**
 * Runs `argv` on `target` with the variables `pass` names copied from the harness's environment, its output shown as it
 * comes and kept in the next logs/<n>-<name>.log, each passed and secret-looking value masked by name in both.
 */
export async function runOn(world: World, target: Target, argv: readonly string[], { pass }: { pass: ReadonlyMap<string, string> }): Promise<{ exit: number; log: string }> {
  if (world.cleanedAt !== undefined) throw new Error(`World ${world.runId} was cleaned up at ${world.cleanedAt}. Make a new one.`);
  const place = placeOf(world, target);

  if (pass.size > 0 && place.env === undefined) throw new Error(`World ${world.runId} was made before --pass, and its commands run with what bin/run sets. Make a new world.`);
  const mask = worldRedactor({ passed: pass, harnessEnv: process.env });
  const before = worldFiles(world);
  const { command, args, env, cwd } = hostCommand(world, place, argv);
  const child = spawn(command, args, { cwd, env: { ...env, ...Object.fromEntries(pass) }, stdio: ['inherit', 'pipe', 'pipe'] });
  let output = '';

  const closed = [child.stdout, child.stderr].map((stream, i) => {
    const to = i === 0 ? process.stdout : process.stderr;
    const lines = lineRedactor(mask);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const shown = lines.push(chunk);
      output += shown;
      to.write(shown);
    });

    return new Promise<void>((resolve) => {
      stream.once('end', () => {
        const shown = lines.end();
        output += shown;
        to.write(shown);
        resolve();
      });
    });
  });

  const status = await new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      output += `${error.message}\n`;
      resolve(127);
    });
    child.once('close', (code) => resolve(code));
  });

  await Promise.all(closed);
  const log = writeCommandLog(world, argv.map(mask), output, status);
  recordWriters(world, argv, before, worldFiles(world));

  return { exit: status ?? 1, log };
}
