import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ContainerEngine } from '../options.js';
import type { Can, PlaceView, RuntimeFailure } from '@teamai/runtime-protocol';
import { sandboxName, type ExecEnd, type Provider } from '../provider.js';

// ─── docker and podman ───────────────────────────────────
//
//  One long-lived container per attempt, idle until teamai execs in it:
//
//    docker run -d --name teamai-<run>-<attempt> --label teamai.run=<run> --label teamai.attempt=<attempt>
//      --user <uid>:<gid>                      (podman: --userns keep-id)
//      --env HOME=/tmp/teamai-home              a private home, never the member's
//      -v <worktree>:<worktree>:rw -v <run dir>:<run dir>:rw -v <git path>:<git path>:ro …   every view path at its host path (,z on SELinux)
//      --entrypoint /bin/sh <image> -c <idle>
//    docker exec -w <cwd> -e NAME … <container> env -u WITHHELD … -- <argv>
//
//  Values never appear in an argv: `-e NAME` takes each from the engine CLI's own environment. Only the names an exec
//  is given cross into the container, so nothing else of teamai's environment does. The container's processes run one
//  exec at a time (teamai opens, execs, collects and closes each attempt in turn), so a stop restarts the container,
//  which ends every process in it and keeps the container for the next exec.
//

/** The tools a step runtime can launch, as `can.tools` lists those an image holds. */
// oxlint-disable-next-line teamai/tool-facts -- teamai's EXEC_RUNTIME_TOOLS, by their executables; a runtime package cannot read teamai's tool registry
const LAUNCHABLE = ['claude', 'codex', 'codebuddy'];

/** The private home of the step's processes inside the container. */
const CONTAINER_HOME = '/tmp/teamai-home';

/** PID 1 of every attempt container: idle, and gone at once on a stop. */
const IDLE = `mkdir -p "$HOME"; trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done`;

/** The engine CLI's own settings: an exec's names never replace them, so a step cannot point the CLI at another daemon. */
const ENGINE_SETTINGS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_CONF'];

/** Seconds a stop waits before the engine kills the container. */
const STOP_GRACE = '10';

type Ran = { kind: 'ran'; code: number; stdout: string; stderr: string } | { kind: 'unstartable'; message: string };

export interface Host {
  /** The member's uid and gid, which the step's processes run as on docker; undefined where the OS has none. */
  user?: { uid: number; gid: number };
  /** Whether SELinux labels the host's files, so each mount needs the shared label. */
  selinux: boolean;
  /** The environment teamai started this runtime with, the engine CLI's own. */
  env: NodeJS.ProcessEnv;
}

export function containerProvider({ engine, image, host }: { engine: ContainerEngine; image: string; host: Host }): Provider {
  const notInstalled = engine === 'docker'
    ? 'docker is not installed here, or not on PATH. Install Docker Desktop (https://docs.docker.com/get-docker/) or Docker Engine, start it, and start again.'
    : 'podman is not installed here, or not on PATH. Install Podman (https://podman.io/docs/installation), run `podman machine init && podman machine start` on macOS or Windows, and start again.';

  // The engine CLI as teamai's PATH finds it: spawn looks a bare name up on the env it is given, and an exec's env may
  // carry the PATH the step wants inside the container.
  const executable = (host.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '').map((dir) => path.join(dir, engine)).find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return true;
    } catch {
      return false;
    }
  }) ?? engine;

  /** Runs the engine CLI once. */
  const cli = (args: string[], { env = host.env, onOutput }: { env?: NodeJS.ProcessEnv; onOutput?: (stream: 'stdout' | 'stderr', data: string) => void } = {}): Promise<Ran> => new Promise((resolve) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; onOutput?.('stdout', data); });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr = `${stderr}${data}`.slice(-8000); onOutput?.('stderr', data); });
    // A CLI that cannot start never closes: ENOENT is a missing engine, anything else (EACCES) is named as it is.
    child.on('error', (error) => resolve({ kind: 'unstartable', message: 'code' in error && error.code === 'ENOENT' ? notInstalled : `${engine} could not be started: ${error.message}` }));
    child.on('close', (code, signal) => resolve({ kind: 'ran', code: code ?? (signal === 'SIGKILL' ? 137 : 143), stdout, stderr }));
  });

  const lastLine = (ran: Ran): string => (ran.kind === 'ran' ? ran.stderr.trim().split('\n').at(-1) ?? '' : '');

  const unavailable = (message: string) => ({ ok: false, failure: { code: 'sandbox_unavailable', message } }) satisfies { ok: false; failure: RuntimeFailure };

  const notRunning = (ran: Ran): string => (engine === 'docker'
    ? `docker is installed, but its daemon is not running (${lastLine(ran)}). Start Docker Desktop, or run \`sudo systemctl start docker\` on Linux, and start again.`
    : `podman cannot reach its service (${lastLine(ran)}). Run \`podman machine start\` on macOS or Windows, or check \`podman info\` on Linux, and start again.`);

  /** `-v` for each view path at its host path; a path the engine's `-v` syntax cannot carry is refused. */
  const mounts = (view: PlaceView): { ok: true; args: string[] } | { ok: false; failure: RuntimeFailure } => {
    const writable = [view.worktree, view.result, view.runDir, ...Object.values(view.toolHome)];
    const args: string[] = [];
    const label = host.selinux ? ',z' : '';

    for (const [mounted, mode] of [...writable.map((at) => [at, 'rw'] as const), ...view.readonly.map((at) => [at, 'ro'] as const)]) {
      if (/[:,]/.test(mounted)) return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} cannot mount ${mounted}: a path with ":" or "," cannot be mounted with -v. Move the checkout to a path without them.` } };

      // A writable path the engine would create is created here first, so the member owns it, not root.
      if (mode === 'rw') fs.mkdirSync(mounted, { recursive: true });
      args.push('-v', `${mounted}:${mounted}:${mode}${label}`);
    }

    return { ok: true, args };
  };

  const find: Provider['find'] = async (key) => {
    const listed = await cli(['ps', '-a', '-q', '--filter', `label=teamai.run=${key.run}`, '--filter', `label=teamai.attempt=${key.attempt}`]);

    return listed.kind === 'ran' && listed.code === 0 ? listed.stdout.trim().split('\n').find((line) => line !== '') : undefined;
  };

  return {
    async offer() {
      const info = await cli(['info', '--format', '{{.ServerVersion}}']);

      if (info.kind === 'unstartable') return unavailable(info.message);

      if (info.code !== 0) return unavailable(notRunning(info));
      const present = await cli(['image', 'inspect', '--format', '{{.Id}}', image]);

      if (present.kind !== 'ran' || present.code !== 0) {
        const pulled = await cli(['pull', image]);

        if (pulled.kind !== 'ran' || pulled.code !== 0) {
          return unavailable(`${engine} could not pull image ${image} (${lastLine(pulled)}). Check its name, and that you are logged in to its registry (\`${engine} login <registry>\`), and start again.`);
        }
      }

      const probe = await cli(['run', '--rm', '--entrypoint', '/bin/sh', image, '-c', `for t in ${LAUNCHABLE.join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; exit 0`]);

      if (probe.kind !== 'ran' || probe.code !== 0) return unavailable(`${engine} could not start a container from ${image} (${lastLine(probe)}). Check that it runs /bin/sh, and start again.`);
      const tools = LAUNCHABLE.filter((tool) => probe.stdout.split('\n').map((line) => line.trim()).includes(tool));

      const can: Can = {
        workspace: ['read-only', 'new', 'continue'], isolation: 'sandbox', env: true, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true,
      };

      return { ok: true, can };
    },

    find,

    async create(key, view) {
      const mounted = mounts(view);

      if (!mounted.ok) return mounted;
      const user = engine === 'podman' ? ['--userns', 'keep-id'] : host.user ? ['--user', `${host.user.uid}:${host.user.gid}`] : [];

      const created = await cli([
        'run', '-d', '--name', sandboxName(key), '--label', `teamai.run=${key.run}`, '--label', `teamai.attempt=${key.attempt}`, ...user,
        '--env', `HOME=${CONTAINER_HOME}`, ...mounted.args, '--entrypoint', '/bin/sh', image, '-c', IDLE,
      ]);

      if (created.kind === 'ran' && created.code === 0) return { ok: true, id: created.stdout.trim() };
      // Another open of the same attempt created it first: that container is this attempt's.
      const existing = await find(key);

      if (existing !== undefined) return { ok: true, id: existing };

      return { ok: false, failure: { code: 'sandbox_failed', message: created.kind === 'unstartable' ? created.message : `${engine} could not create the container for attempt ${key.attempt} from ${image}: ${lastLine(created)}` } };
    },

    async exec(id, spec, onOutput): Promise<ExecEnd> {
      const env: NodeJS.ProcessEnv = { ...host.env, ...spec.env };

      for (const setting of ENGINE_SETTINGS) env[setting] = host.env[setting];
      const withheld = spec.unset.length > 0 ? ['env', ...spec.unset.flatMap((variable) => ['-u', variable]), '--'] : [];
      const ran = await cli(['exec', '-w', spec.cwd, ...Object.keys(spec.env).flatMap((variable) => ['-e', variable]), id, ...withheld, ...spec.argv], { env, onOutput });

      return ran.kind === 'ran' ? { kind: 'exited', code: ran.code } : { kind: 'failed', failure: { code: 'exec_failed', message: ran.message } };
    },

    async stop(id) {
      await cli(['restart', '--time', STOP_GRACE, id]);
    },

    async destroy(id) {
      const removed = await cli(['rm', '--force', id]);

      if (removed.kind === 'ran' && (removed.code === 0 || /no such container/i.test(removed.stderr))) return { ok: true };

      return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not remove container ${id}: ${lastLine(removed)}. Remove it with \`${engine} rm --force ${id}\`.` } };
    },

    display: (key) => ({ label: `${sandboxName(key)} (${engine})`, fields: { container: sandboxName(key), image } }),
  };
}
