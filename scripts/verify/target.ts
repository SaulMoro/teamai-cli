/**
 * Where a world's command runs: the world's project, as its HOME. Every verb that runs something in a world (teamai, sh,
 * the ledger's uninstall) runs it through `runOn`, which builds its environment, shows and logs its output, and records
 * what a member's own program wrote.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { lineRedactor, worldRedactor } from './secrets.js';
import { MEMBER_NAME } from './members.js';
import { recordWriters, worldFiles, worldWritersFile, writeCommandLog, type Member, type World } from './world.js';

export type Target = { kind: 'world' } | { kind: 'member'; name: string };

/** The run id and the target a verb's first argument names: `<run>`, or `<run>@<member>`. */
export function parseTarget(arg: string | undefined) {
  const at = arg?.indexOf('@') ?? -1;

  if (arg === undefined || at === -1) {
    const target: Target = { kind: 'world' };

    return { runId: arg, target };
  }

  const name = arg.slice(at + 1);

  if (!MEMBER_NAME.test(name)) throw new Error(`${name} is not a member name: a lowercase letter, then up to 11 lowercase letters, digits or dashes.`);
  const target: Target = { kind: 'member', name };

  return { runId: arg.slice(0, at), target };
}

/** The member `name` of `world`, or why there is none. */
export function memberOf(world: World, name: string): Member {
  const member = world.members?.find((each) => each.name === name);

  if (member === undefined) throw new Error(`World ${world.runId} has no member ${name}. Add one with \`npm run -s verify -- member ${world.runId} ${name}\`.`);

  return member;
}

/** The HOME, project, env and writers a target's commands run with. */
function placeOf(world: World, target: Target) {
  switch (target.kind) {
    case 'world': return { home: world.home, project: world.project, env: world.env, writers: worldWritersFile(world) };
    case 'member': {
      const { home, project, env, writers } = memberOf(world, target.name);

      return { home, project, env, writers };
    }

    default: {
      const unknown: never = target;

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
  const before = worldFiles(place);
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
  recordWriters(place.writers, argv, before, worldFiles(place));

  return { exit: status ?? 1, log };
}

/** Runs a probe `argv` on `target` and answers what it printed, unlogged: how the ledger reads a machine. */
export function captureOn(world: World, target: Target, argv: readonly string[], { timeoutMs = 30_000 }: { timeoutMs?: number } = {}) {
  const place = placeOf(world, target);
  const [command = 'true', ...args] = argv;
  const ran = spawnSync(command, args, { cwd: place.project, env: place.env ?? process.env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 ** 2 });

  return { code: ran.error === undefined ? ran.status : null, stdout: ran.stdout ?? '', why: ran.error?.message ?? ran.stderr?.trim().split('\n').at(-1) ?? '' };
}

/** Each machine a world's commands run on: this one, whose process table every member on it shares, and each member's container. */
export function machinesOf(world: World): Array<{ label: string; target: Target; platform: NodeJS.Platform }> {
  return [
    { label: 'this machine', target: { kind: 'world' }, platform: process.platform },
    ...(world.members ?? []).flatMap((member) => (member.machine === 'container' ? [{ label: `@${member.name}'s container`, target: { kind: 'member' as const, name: member.name }, platform: 'linux' as const }] : [])),
  ];
}
