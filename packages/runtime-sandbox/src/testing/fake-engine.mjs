#!/usr/bin/env node
// A stand-in `docker` / `podman` for tests: the subset of the CLI the container provider runs, against a state
// directory instead of a daemon. A container's processes run on the host, in a process group of their own, with only
// the environment a real container would give them: the image's PATH, the `--env` of `run`, and each `-e NAME` of
// `exec` taken from this process's own environment. An `exec` whose working directory no mount covers fails as it
// would in a container; one that a mount covers runs in that mount's host directory. Every argv is appended to
// FAKE_ENGINE_LOG as one JSON line; no environment value is written.
//
//   FAKE_ENGINE_STATE   its state directory; a file `down` there makes it answer as a stopped daemon, and a file
//                       `rm-fails` makes `rm` fail as a daemon that cannot remove the container
//   FAKE_ENGINE_IMAGES  JSON: image name -> the directory its tools are in (the image's PATH)
//   FAKE_ENGINE_NAME    docker or podman, which it answers as
//   FAKE_ENGINE_LOG     optional: where argv lines go
//   FAKE_ENGINE_VERSION optional: the server version `info` reports, 27.3.1 when unset
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const state = process.env.FAKE_ENGINE_STATE;
const images = JSON.parse(process.env.FAKE_ENGINE_IMAGES ?? '{}');
const args = process.argv.slice(2);
const engine = process.env.FAKE_ENGINE_NAME ?? 'docker';

if (process.env.FAKE_ENGINE_LOG) fs.appendFileSync(process.env.FAKE_ENGINE_LOG, `${JSON.stringify([engine, ...args])}\n`);

const containers = path.join(state, 'containers');

fs.mkdirSync(containers, { recursive: true });

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readContainer(ref) {
  for (const id of fs.readdirSync(containers)) {
    const file = path.join(containers, id, 'container.json');

    if (!fs.existsSync(file)) continue;
    const container = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (id === ref || container.name === ref) return container;
  }

  return undefined;
}

function writeContainer(container) {
  const file = path.join(containers, container.id, 'container.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(container));
  fs.renameSync(`${file}.tmp`, file);
}

/** Stops every process group an exec of the container started, as a container stop does. */
function killProcesses(container) {
  const dir = path.join(containers, container.id, 'execs');

  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-Number(name), signal); } catch { /* gone */ }
    }

    fs.rmSync(path.join(dir, name), { force: true });
  }
}

/** Splits `args` into the options of a subcommand (flags with a value) and the rest, from the first positional. */
function options(list, withValue, boolean = []) {
  const found = [];
  let at = 0;

  while (at < list.length && list[at].startsWith('-')) {
    const flag = list[at];

    if (boolean.includes(flag)) {
      found.push([flag, true]);
      at += 1;
    } else if (withValue.includes(flag)) {
      found.push([flag, list[at + 1]]);
      at += 2;
    } else {
      fail(`fake engine: unknown flag ${flag}`, 125);
    }
  }

  return { found, rest: list.slice(at) };
}

function all(found, flag) {
  return found.filter(([name]) => name === flag).map(([, value]) => value);
}

function one(found, flag) {
  return all(found, flag).at(-1);
}

function imagePath(image) {
  return `${images[image]}${path.delimiter}/usr/bin${path.delimiter}/bin`;
}

function pulled(image) {
  return fs.existsSync(path.join(state, 'pulled', encodeURIComponent(image)));
}

/** Runs `argv` in `cwd` with `env` as one of the container's processes, and exits as it does. */
function runProcess(container, argv, cwd, env, stdin) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: [stdin ? 'inherit' : 'ignore', 'inherit', 'inherit'] });
  const execs = path.join(containers, container.id, 'execs');
  fs.mkdirSync(execs, { recursive: true });
  child.on('spawn', () => fs.writeFileSync(path.join(execs, String(child.pid)), ''));
  child.on('error', (error) => fail(`OCI runtime exec failed: ${error.message}: executable file not found in $PATH`, 127));
  child.on('close', (code, signal) => {
    fs.rmSync(path.join(execs, String(child.pid)), { force: true });
    process.exit(signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code ?? 1);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {});
}

const [command, ...rest] = args;

if (command === '--version' || command === 'version') {
  process.stdout.write(`${engine} version 0.0.0-fake\n`);
  process.exit(0);
}

if (fs.existsSync(path.join(state, 'down'))) fail(`Cannot connect to the ${engine === 'podman' ? 'Podman' : 'Docker'} daemon. Is the daemon running?`);

switch (command) {
  case 'info': {
    // Each engine's own template field for its version.
    const format = rest[rest.indexOf('--format') + 1] ?? '';

    if (format.includes(engine === 'podman' ? 'ServerVersion' : 'Version.Version')) fail(`Error: template: info:1:2: executing "info" at <${format}>: can't evaluate field`, 125);
    process.stdout.write(`${process.env.FAKE_ENGINE_VERSION ?? (engine === 'podman' ? '5.2.3' : '27.3.1')}\n`);
    break;
  }

  case 'image': {
    const [, , , image] = rest;

    if (rest[0] !== 'inspect' || !pulled(image)) fail(`Error: No such image: ${image}`);
    process.stdout.write(`sha256:${crypto.createHash('sha256').update(image).digest('hex')}\n`);
    break;
  }

  case 'pull': {
    const [image] = rest;

    if (images[image] === undefined) fail(`Error response from daemon: pull access denied for ${image}, repository does not exist`);
    fs.mkdirSync(path.join(state, 'pulled'), { recursive: true });
    fs.writeFileSync(path.join(state, 'pulled', encodeURIComponent(image)), '');
    break;
  }

  case 'run': {
    const { found, rest: positional } = options(rest, ['--name', '--label', '--user', '--userns', '--env', '-v', '--entrypoint', '--network', '--cap-drop', '--security-opt'], ['-d', '--rm']);
    const [image, ...entry] = positional;

    if (!pulled(image)) fail(`Unable to find image '${image}' locally`, 125);

    if (one(found, '--rm')) {
      // A probe: run the entrypoint once, on the image's PATH.
      const probe = spawn(one(found, '--entrypoint'), entry, { env: { PATH: imagePath(image) }, stdio: ['ignore', 'inherit', 'inherit'] });
      probe.on('close', (code) => process.exit(code ?? 1));
      break;
    }

    const name = one(found, '--name');

    if (name && readContainer(name)) fail(`Conflict. The container name "/${name}" is already in use.`, 125);
    const network = one(found, '--network');

    if (network && !fs.existsSync(path.join(state, 'networks', network))) fail(`Error response from daemon: network ${network} not found`, 125);
    const id = crypto.randomBytes(16).toString('hex');

    writeContainer({
      id, name, image, running: true,
      labels: Object.fromEntries(all(found, '--label').map((label) => label.split(/=(.*)/s).slice(0, 2))),
      env: Object.fromEntries(all(found, '--env').map((pair) => pair.split(/=(.*)/s).slice(0, 2))),
      mounts: all(found, '-v').map((volume) => {
        const [source, target, mode] = volume.split(':');

        return { source, target, readonly: mode.split(',').includes('ro') };
      }),
    });

    process.stdout.write(`${id}\n`);
    break;
  }

  case 'ps': {
    const { found } = options(rest, ['--filter', '--format'], ['-a', '-q']);
    const wanted = all(found, '--filter').map((filter) => filter.replace(/^label=/, '').split(/=(.*)/s).slice(0, 2));

    for (const id of fs.readdirSync(containers)) {
      const container = readContainer(id);

      if (container && wanted.every(([key, value]) => container.labels[key] === value)) process.stdout.write(`${container.id}\n`);
    }

    break;
  }

  case 'exec': {
    const { found, rest: positional } = options(rest, ['-w', '-e', '--user'], ['-i']);
    const [ref, ...argv] = positional;
    const container = readContainer(ref);

    if (!container) fail(`Error response from daemon: No such container: ${ref}`);

    if (!container.running) fail(`Error response from daemon: container ${container.id} is not running`);
    const cwd = one(found, '-w') ?? '/';
    // The process runs on the host, so it starts in the host directory mounted where the container's cwd is.
    const mount = container.mounts.filter(({ target }) => cwd === target || cwd.startsWith(`${target}/`)).sort((a, b) => b.target.length - a.target.length)[0];

    if (!mount) fail(`OCI runtime exec failed: chdir to cwd ("${cwd}") set in config.json failed: no such file or directory`, 126);
    const home = path.join(containers, container.id, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = { PATH: imagePath(container.image), ...container.env, HOME: home };

    for (const name of all(found, '-e')) if (process.env[name] !== undefined) env[name] = process.env[name];
    runProcess(container, argv, mount.source + cwd.slice(mount.target.length), env, one(found, '-i'));
    break;
  }

  case 'restart': {
    const { rest: positional } = options(rest, ['--time', '-t']);
    const container = readContainer(positional[0]);

    if (!container) fail(`Error response from daemon: No such container: ${positional[0]}`);
    killProcesses(container);
    process.stdout.write(`${positional[0]}\n`);
    break;
  }

  case 'rm': {
    const { rest: positional } = options(rest, [], ['--force', '-f']);
    const container = readContainer(positional[0]);

    if (fs.existsSync(path.join(state, 'rm-fails'))) fail(`Error response from daemon: cannot remove container "${positional[0]}": could not kill: tried to kill container, but did not receive an exit event`);

    if (!container) fail(`Error response from daemon: No such container: ${positional[0]}`);
    killProcesses(container);
    fs.rmSync(path.join(containers, container.id), { recursive: true, force: true });
    process.stdout.write(`${positional[0]}\n`);
    break;
  }

  case 'network': {
    // Networks are names only: a container's processes run on the host either way.
    const [action, ...more] = rest;
    const networks = path.join(state, 'networks');
    fs.mkdirSync(networks, { recursive: true });

    if (action === 'create') {
      const { rest: [name] } = options(more, ['--label', '-o'], ['--internal']);

      if (fs.existsSync(path.join(networks, name))) fail(`Error response from daemon: network with name ${name} already exists`);
      fs.writeFileSync(path.join(networks, name), '');
      process.stdout.write(`${crypto.randomBytes(16).toString('hex')}\n`);
    } else if (action === 'connect') {
      const [name, ref] = more;

      if (!fs.existsSync(path.join(networks, name))) fail(`Error response from daemon: network ${name} not found`);

      if (!readContainer(ref)) fail(`Error response from daemon: No such container: ${ref}`);
    } else if (action === 'rm') {
      const [name] = more;

      if (!fs.existsSync(path.join(networks, name))) fail(`Error response from daemon: network ${name} not found`);
      fs.rmSync(path.join(networks, name));
      process.stdout.write(`${name}\n`);
    } else {
      fail(`fake engine: unsupported network command ${action}`, 125);
    }

    break;
  }

  default:
    fail(`fake engine: unsupported command ${command}`, 125);
}
