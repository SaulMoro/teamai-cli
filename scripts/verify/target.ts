/**
 * Where a world's command runs: the world's project, as its HOME. Every verb that runs something in a world (teamai, sh,
 * the ledger's uninstall) runs it through `runOn`, which builds its environment, shows and logs its output, and records
 * what a member's own program wrote.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lineRedactor, worldRedactor } from './secrets.js';
import { MEMBER_NAME } from './members.js';
import { recordWriters, runtimeStateDirs, worldFiles, worldWritersFile, writeCommandLog, type Member, type World } from './world.js';

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

/** The machine a place's commands run on: this one, or a member's container, reached through docker exec. */
type Machine = { kind: 'host' } | { kind: 'container'; container: string };

/** The HOME, project, env, writers and machine a target's commands run with. */
function placeOf(world: World, target: Target) {
  switch (target.kind) {
    case 'world': {
      const machine: Machine = { kind: 'host' };

      return { home: world.home, project: world.project, env: world.env, writers: worldWritersFile(world), machine };
    }

    case 'member': {
      const member = memberOf(world, target.name);
      const machine: Machine = member.machine === 'container' ? { kind: 'container', container: member.container } : { kind: 'host' };

      return { home: member.home, project: member.project, env: member.env, writers: member.writers, machine };
    }

    default: {
      const unknown: never = target;

      return unknown;
    }
  }
}

/**
 * What runs `argv` in a member's container: docker exec, each variable given by name only so no value is in an argument,
 * the container's PATH aside, and the docker CLI's own config kept where the harness has it, never under the member's HOME.
 */
export function containerCommand({ container, env, pass, cwd, argv, harnessEnv }: { container: string; env: Readonly<Record<string, string>>; pass: ReadonlyMap<string, string>; cwd: string; argv: readonly string[]; harnessEnv: NodeJS.ProcessEnv }) {
  const { PATH: inside = '', ...named } = { ...env, ...Object.fromEntries(pass) };
  const engine = Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONTEXT'].flatMap((name) => (harnessEnv[name] === undefined ? [] : [[name, harnessEnv[name]]])));

  return {
    command: 'docker',
    args: ['exec', '-i', '-w', cwd, '-e', `PATH=${inside}`, ...Object.keys(named).flatMap((name) => ['-e', name]), container, ...argv],
    env: { ...named, ...engine, PATH: harnessEnv.PATH ?? '', DOCKER_CONFIG: harnessEnv.DOCKER_CONFIG ?? path.join(harnessEnv.HOME ?? '', '.docker') },
    cwd: '/',
  };
}

/** What a process gets to run `argv` on its place: the frozen env (bin/run in a world made before it was kept), on the place's machine. */
function commandOf(world: World, place: ReturnType<typeof placeOf>, argv: readonly string[], { pass, cwd = place.project }: { pass: ReadonlyMap<string, string>; cwd?: string }) {
  const { machine } = place;

  switch (machine.kind) {
    case 'host': {
      if (place.env === undefined) return { command: path.join(world.bin, 'run'), args: [...argv], env: {} satisfies NodeJS.ProcessEnv, cwd };
      const [command = 'true', ...args] = argv;

      return { command, args, env: { ...place.env, ...Object.fromEntries(pass) }, cwd };
    }

    case 'container':
      return containerCommand({ container: machine.container, env: place.env ?? {}, pass, cwd, argv, harnessEnv: process.env });
    default: {
      const unknown: never = machine;

      return unknown;
    }
  }
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
  const { command, args, env, cwd } = commandOf(world, place, argv, { pass });
  const child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
  const watching = watchSandboxes(world, { pass, label: argv.slice(0, 3).map(mask).join(' ') });
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

  for (const line of await watching.stop()) {
    console.log(line);
    output += `${line}\n`;
  }

  const log = writeCommandLog(world, argv.map(mask), output, status);
  recordWriters(place.writers, argv, before, worldFiles(place));

  return { exit: status ?? 1, log };
}

/**
 * Watches for the state a runtime outside teamai's process keeps under a HOME of the world, one stat a second, and
 * starts the observer (observer.ts) once it is there: a command that runs no such runtime loads none of it.
 */
function hasRuntimeState(world: World): boolean {
  return runtimeStateDirs(world).some((dir) => fs.existsSync(dir));
}

function watchSandboxes(world: World, { pass, label }: { pass: ReadonlyMap<string, string>; label: string }) {
  let observer: Promise<{ stop(): Promise<string[]> }> | undefined;

  // A failure of the observer's own is a line of the command's output, never the end of the harness's process.
  const startWatching = async (): Promise<{ stop(): Promise<string[]> }> => {
    try {
      const { startObserver } = await import('./observer.js');

      return startObserver(world, { pass, label });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);

      return { stop: () => Promise.resolve([`[verify] NOT OBSERVED: the sandbox observer stopped, ${why}`]) };
    }
  };

  const look = (): void => {
    if (observer !== undefined || !hasRuntimeState(world)) return;
    observer = startWatching();
  };

  const timer = setInterval(look, 1_000);

  look();

  return {
    async stop(): Promise<string[]> {
      clearInterval(timer);
      look();

      return observer === undefined ? [] : (await observer).stop();
    },
  };
}

/** Runs a probe `argv` on `target` and answers what it printed, unlogged: how the ledger reads a machine. */
export function captureOn(world: World, target: Target, argv: readonly string[], { timeoutMs = 30_000 }: { timeoutMs?: number } = {}) {
  const place = placeOf(world, target);
  // From /, so the probe's own processes name no path of the world.
  const { command, args, env } = commandOf(world, { ...place, env: place.env ?? Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]]))) }, argv, { pass: new Map(), cwd: '/' });
  const ran = spawnSync(command, args, { cwd: '/', env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 ** 2 });

  return { code: ran.error === undefined ? ran.status : null, stdout: ran.stdout ?? '', why: ran.error?.message ?? ran.stderr?.trim().split('\n').at(-1) ?? '' };
}

/** Each machine a world's commands run on: this one, whose process table every member on it shares, and each member's container. */
export function machinesOf(world: World): Array<{ label: string; target: Target; platform: NodeJS.Platform }> {
  return [
    { label: 'this machine', target: { kind: 'world' }, platform: process.platform },
    ...(world.members ?? []).flatMap((member) => (member.machine === 'container' ? [{ label: `@${member.name}'s container`, target: { kind: 'member' as const, name: member.name }, platform: 'linux' as const }] : [])),
  ];
}
