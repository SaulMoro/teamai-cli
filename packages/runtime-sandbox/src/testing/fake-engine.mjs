#!/usr/bin/env node
// A stand-in `docker` / `podman` / `sbx` for tests: the subset of each CLI its provider runs, against a state
// directory instead of a daemon. An sbx sandbox is kept as a container whose image is its agent, mounted at its
// workspaces' host paths. A container's processes run on the host, in a process group of their own, with only
// the environment a real container would give them: the image's PATH, the `--env` of `run`, and each `-e NAME` of
// `exec` taken from this process's own environment. An `exec` whose working directory no mount covers fails as it
// would in a container; one that a mount covers runs in that mount's host directory. Every argv is appended to
// FAKE_ENGINE_LOG as one JSON line; no environment value is written.
//
//   FAKE_ENGINE_STATE   its state directory; a file `down` there makes it answer as a stopped daemon, a file
//                       `rm-fails` makes `rm` fail as a daemon that cannot remove the container, a file `no-policy`
//                       makes sbx answer as one whose network policy was never initialized, and a file
//                       `secrets/<service>` is an sbx secret its proxy holds; a file `stop-lag` holding a number of
//                       milliseconds makes an `exec` whose process was stopped end that much later, as a real exec
//                       client notices its container stopped only after the stop command returns; a file
//                       `stop-delay` holding a number of milliseconds makes `restart` (sbx: `stop`) wait that long
//                       before it stops anything, as a daemon that is slow to answer; a file `stop-hold` holding a
//                       number of milliseconds makes it wait that long once it stopped the processes, before it
//                       answers, as an engine that restarts the container does; a file `delay-<command>`
//                       holding a number of milliseconds makes that command (`run`, `rm`, …) wait that long first;
//                       a file `format-fails` makes `ps --format` fail as an engine that cannot render it; a file
//                       `create-hold` holding a number of milliseconds makes `run -d` wait that long after the container
//                       exists, before it answers, as a create still on its way; a file `owned-hold` makes a `ps`
//                       filtered by `teamai.owner` wait until it is removed (60 s at most), with a file `owned-listing`
//                       there while it waits; each list of one journal's containers it answered adds a character to
//                       a file `owned-listed`
//   FAKE_ENGINE_IMAGES  JSON: image (or sbx agent) name -> the directory its tools are in (the image's PATH)
//   FAKE_ENGINE_NAME    docker, podman or sbx, which it answers as
//   FAKE_ENGINE_LOG     optional: where argv lines go
//   FAKE_ENGINE_VERSION optional: the server version `info` reports, 27.3.1 when unset
//   FAKE_ENGINE_OS      optional: the OperatingSystem docker's `info` reports, "Docker Desktop" when unset
//
//  sbx answers `policy check network --json <target>` from a file `allowed-network` in its state directory, one
//  `localhost:<port>` per line, as `sbx policy allow network` adds them; host.docker.internal is checked as localhost.
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
    const lag = signal && fs.existsSync(path.join(state, 'stop-lag')) ? Number(fs.readFileSync(path.join(state, 'stop-lag'), 'utf8')) : 0;
    setTimeout(() => process.exit(signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code ?? 1), lag);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {});
}

/** Waits as long as the file `name` in the state directory says, when there is one. */
function waitAsLongAs(name) {
  const file = path.join(state, name);

  if (fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(file, 'utf8')));
}

/** Waits as long as `stop-delay` says, before a stop does anything. */
function delayStop() {
  waitAsLongAs('stop-delay');
}

const [command, ...rest] = args;
const commandDelay = path.join(state, `delay-${command}`);

if (fs.existsSync(commandDelay)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(commandDelay, 'utf8')));

if (command === '--version' || command === 'version') {
  process.stdout.write(`${engine} version 0.0.0-fake\n`);
  process.exit(0);
}

if (engine === 'sbx') sbx();
else docker();

/** Answers as docker or podman. */
function docker() {
  if (fs.existsSync(path.join(state, 'down'))) fail(`Cannot connect to the ${engine === 'podman' ? 'Podman' : 'Docker'} daemon. Is the daemon running?`);

  switch (command) {
    case 'info': {
      // Each engine's own template field for its version.
      const format = rest[rest.indexOf('--format') + 1] ?? '';

      if (format.includes(engine === 'podman' ? 'ServerVersion' : 'Version.Version')) fail(`Error: template: info:1:2: executing "info" at <${format}>: can't evaluate field`, 125);
      const version = process.env.FAKE_ENGINE_VERSION ?? (engine === 'podman' ? '5.2.3' : '27.3.1');
      process.stdout.write(`${format.replace('{{.ServerVersion}}', version).replace('{{.Version.Version}}', version).replace('{{.OperatingSystem}}', process.env.FAKE_ENGINE_OS ?? 'Docker Desktop')}\n`);
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
      const hold = path.join(state, 'create-hold');

      writeContainer({
        id, name, image, running: true,
        labels: Object.fromEntries(all(found, '--label').map((label) => label.split(/=(.*)/s).slice(0, 2))),
        env: Object.fromEntries(all(found, '--env').map((pair) => pair.split(/=(.*)/s).slice(0, 2))),
        mounts: all(found, '-v').map((volume) => {
          const [source, target, mode] = volume.split(':');

          return { source, target, readonly: mode.split(',').includes('ro') };
        }),
      });

      if (fs.existsSync(hold)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(hold, 'utf8')));
      process.stdout.write(`${id}\n`);
      break;
    }

    case 'ps': {
      const { found } = options(rest, ['--filter', '--format'], ['-a', '-q']);

      if (one(found, '--format') !== undefined && fs.existsSync(path.join(state, 'format-fails'))) fail('Error: template: ps:1: function "Label" not defined', 125);
      const wanted = all(found, '--filter').map((filter) => filter.replace(/^label=/, '').split(/=(.*)/s).slice(0, 2));

      // A list of one journal's containers waits while `owned-hold` exists, marked `owned-listing` meanwhile.
      if (wanted.some(([key]) => key === 'teamai.owner') && fs.existsSync(path.join(state, 'owned-hold'))) {
        fs.writeFileSync(path.join(state, 'owned-listing'), '');

        for (let waited = 0; waited < 60_000 && fs.existsSync(path.join(state, 'owned-hold')); waited += 50) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        fs.rmSync(path.join(state, 'owned-listing'), { force: true });
      }

      // The fields of `--format` the providers use: the id and a label's value, empty when it has none.
      const format = one(found, '--format') ?? '{{.ID}}';

      for (const id of fs.readdirSync(containers)) {
        const container = readContainer(id);

        if (container && wanted.every(([key, value]) => container.labels[key] === value)) process.stdout.write(`${format.replaceAll('{{.ID}}', container.id).replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, key) => container.labels[key] ?? '')}\n`);
      }

      if (wanted.some(([key]) => key === 'teamai.owner')) fs.appendFileSync(path.join(state, 'owned-listed'), '.');

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
      delayStop();
      const { rest: positional } = options(rest, ['--time', '-t']);
      const container = readContainer(positional[0]);

      if (!container) fail(`Error response from daemon: No such container: ${positional[0]}`);
      killProcesses(container);
      waitAsLongAs('stop-hold');
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
}

/** The sbx placeholders a sandbox's env holds for the logins its proxy injects, never a value. */
function proxyEnv() {
  const env = { GH_TOKEN: 'proxy-managed' };

  if (fs.existsSync(path.join(state, 'secrets', 'openai'))) env.OPENAI_API_KEY = 'proxy-managed';

  if (fs.existsSync(path.join(state, 'secrets', 'anthropic'))) env.ANTHROPIC_API_KEY = 'proxy-managed';

  return env;
}

/** Answers as sbx 0.50.1, with its messages: `error: …` then `  try: …`. */
function sbx() {
  const sbxFail = (message, hint, code = 1) => fail(`error: ${message}${hint ? `\n  try: ${hint}` : ''}`, code);

  if (fs.existsSync(path.join(state, 'down'))) sbxFail('cannot connect to sandboxd: connection refused', 'sbx daemon start');

  if (['create', 'policy'].includes(command) && fs.existsSync(path.join(state, 'no-policy'))) sbxFail('global network policy has not been initialized', 'sbx policy init <allow-all|balanced|deny-all>');

  const sandboxes = () => fs.readdirSync(containers).map(readContainer).filter((container) => container !== undefined);

  switch (command) {
    case 'policy': {
      if (rest[0] !== 'check') {
        process.stdout.write('local-policy   local   all   network: 195 allow\n');
        break;
      }

      // `sbx policy check network --json <target>`, as sbx 0.51.0 answers it: exit 1 when it is not allowed.
      const target = rest.at(-1).replace(/^host\.docker\.internal:/, 'localhost:');
      const allowed = fs.existsSync(path.join(state, 'allowed-network')) && fs.readFileSync(path.join(state, 'allowed-network'), 'utf8').split('\n').includes(target);
      process.stdout.write(`${JSON.stringify({ action: 'net:connect:tcp', allowed, context: 'global', resource_value: target, target, type: 'network', ...(!allowed && { reason: 'No matching allow rule (default deny)' }) })}\n`);
      process.exit(allowed ? 0 : 1);
    }

    case 'secret': {
      // `sbx secret ls --global --json`, as sbx 0.51.0 prints it: each stored secret's scope, type and service, its value masked.
      if (rest[0] !== 'ls' || !rest.includes('--json')) fail(`fake sbx: unsupported secret command ${rest.join(' ')}`, 125);
      const stored = fs.existsSync(path.join(state, 'secrets')) ? fs.readdirSync(path.join(state, 'secrets')) : [];
      process.stdout.write(`${JSON.stringify({ secrets: stored.map((name) => ({ scope: 'global', type: 'service', name, secret: '********' })), custom_secrets: [], shadowed_services: [], env_only_count: 0 })}\n`);
      break;
    }

    case 'ls':
      process.stdout.write(`${JSON.stringify(sandboxes().map(({ name, image, running, mounts }) => ({ name, agent: image, status: running ? 'running' : 'stopped', workspaces: mounts.map(({ source, readonly }) => `${source}${readonly ? ':ro' : ''}`) })))}\n`);
      break;
    case 'create': {
      const { found, rest: positional } = options(rest, ['--name', '-e', '--env', '-t', '--template'], ['--no-progress']);
      const [agent, ...paths] = positional;

      if (images[agent] === undefined) sbxFail(`unknown agent "${agent}"`, 'sbx create --help');
      const name = one(found, '--name') ?? `${agent}-${path.basename(paths[0] ?? 'none')}`;

      if (readContainer(name)) sbxFail(`sandbox '${name}' already exists; connect to the existing sandbox`, `sbx run --name ${name}`);

      const mounts = paths.map((entry) => {
        const readonly = entry.endsWith(':ro');
        const source = readonly ? entry.slice(0, -3) : entry;

        if (!fs.existsSync(source)) sbxFail(`workspace ${source} does not exist`);

        return { source, target: source, readonly };
      });

      const id = crypto.randomBytes(16).toString('hex');
      writeContainer({ id, name, image: agent, running: true, labels: {}, env: proxyEnv(), mounts });

      // sbx's claude template keeps Claude's sign-in in its default home as a stand-in the proxy swaps for the login.
      if (fs.existsSync(path.join(images[agent], 'claude'))) {
        fs.mkdirSync(path.join(containers, id, 'home', '.claude'), { recursive: true });
        fs.writeFileSync(path.join(containers, id, 'home', '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"proxy-managed"}}');
      }

      process.stdout.write(`  ✓ Created sandbox ${name}\n`);
      break;
    }

    case 'exec': {
      const { found, rest: positional } = options(rest, ['-w', '--workdir', '-e', '--env', '-u', '--user'], ['-i', '-t']);
      const [name, ...argv] = positional;
      const sandbox = readContainer(name);

      if (!sandbox) sbxFail(`sandbox '${name}' not found`, 'sbx ls', 125);

      if (!sandbox.running) {
        writeContainer({ ...sandbox, running: true });
        process.stderr.write(`  ✓ sandbox ${name} — started\n`);
      }

      const home = path.join(containers, sandbox.id, 'home');
      fs.mkdirSync(home, { recursive: true });
      // Without -w, a process starts in the primary workspace, or in the agent's home when the sandbox has none.
      const cwd = one(found, '-w') ?? sandbox.mounts[0]?.target;
      const mount = cwd === undefined ? { source: home, target: '' } : sandbox.mounts.filter(({ target }) => cwd === target || cwd.startsWith(`${target}/`)).sort((a, b) => b.target.length - a.target.length)[0];

      if (!mount) fail(`OCI runtime exec failed: chdir to cwd ("${cwd}") set in config.json failed: no such file or directory`, 126);
      const env = { PATH: imagePath(sandbox.image), ...sandbox.env, HOME: home };

      for (const variable of all(found, '-e')) if (process.env[variable] !== undefined) env[variable] = process.env[variable];
      runProcess(sandbox, argv, mount.source + (cwd ?? '').slice(mount.target.length), env, one(found, '-i'));

      return;
    }

    case 'stop': {
      delayStop();

      for (const name of rest) {
        const sandbox = readContainer(name);

        if (!sandbox) sbxFail(`sandbox '${name}' not found`, 'sbx ls');
        killProcesses(sandbox);
        writeContainer({ ...sandbox, running: false });
        waitAsLongAs('stop-hold');
        process.stdout.write(`Stopped sandbox ${name}\n`);
      }

      break;
    }

    case 'rm': {
      const { rest: names } = options(rest, [], ['--force', '-f']);

      if (fs.existsSync(path.join(state, 'rm-fails'))) sbxFail(`failed to remove sandbox '${names[0]}': sandboxd: context deadline exceeded`);

      for (const name of names) {
        const sandbox = readContainer(name);

        if (!sandbox) sbxFail(`sandbox '${name}' not found`, 'sbx ls');
        killProcesses(sandbox);
        fs.rmSync(path.join(containers, sandbox.id), { recursive: true, force: true });
        process.stdout.write(`Removed sandbox ${name}\n`);
      }

      break;
    }

    default:
      fail(`fake sbx: unsupported command ${command}`, 125);
  }

  process.exit(0);
}
