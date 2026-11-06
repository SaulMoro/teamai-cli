import type { ContainerEngine } from '../options.js';
import type { JournalId } from '../journal.js';
import type { Can, ConfinedOffer, RuntimeFailure } from '@teamai/runtime-protocol';
import { EVIDENCE_DIR, FILTER_PORT, FILTER_SCRIPT, judgeTool } from '../judge.js';
import { COMMAND_MS, handleOf, type ExecEnd, type HostRoute, type PlaceKey, type Provider } from '../provider.js';
import { offerSignedIn } from '../sign-in.js';
import { cliOf, LAUNCHABLE, mountsOf, unmountable, WORKSPACES, type Ran } from './cli.js';

// ─── docker and podman ───────────────────────────────────
//
//  One long-lived container per attempt, idle until teamai execs in it:
//
//    docker run -d --name teamai-<run>-<attempt> --label teamai.run=<run> --label teamai.attempt=<attempt> --label teamai.owner=<journal>
//      --user <uid>:<gid>                      (podman: --userns keep-id)
//      --env HOME=/tmp/teamai-home              a private home, never the member's
//      -v <worktree>:<worktree>:rw -v <run dir>:<run dir>:rw -v <git path>:<git path>:ro …   every view path at its host path (,z on SELinux)
//      --entrypoint /bin/sh <image> -c <idle>
//    docker exec -w <cwd> -e NAME … <container> env -u WITHHELD … -- <argv>
//
//  A judge gets a container of its own, with no route out but a filter that lets through only its model provider:
//
//    docker network create --internal -o com.docker.network.bridge.inhibit_ipv4=true <name>-net
//    docker run -d --name <name>-proxy … --entrypoint node <image> -e <filter> 3128 api.anthropic.com:443
//    docker network connect <name>-net <name>-proxy        the filter alone is on both networks
//    docker run -d --name <name> … --network <name>-net --cap-drop ALL --security-opt no-new-privileges
//      --env HTTPS_PROXY=http://<name>-proxy:3128 -v <dir>:/evidence:ro --entrypoint /bin/sh <image> -c <idle>
//
//  Values never appear in an argv: `-e NAME` takes each from the engine CLI's own environment. Only the names an exec
//  is given cross into the container, so nothing else of teamai's environment does. The container's processes run one
//  exec at a time (teamai opens, execs, collects and closes each attempt in turn), so a stop restarts the container,
//  which ends every process in it and keeps the container for the next exec.
//

/** The private home of the step's processes inside the container. */
const CONTAINER_HOME = '/tmp/teamai-home';

/** PID 1 of every attempt container: idle, and gone at once on a stop. */
const IDLE = `mkdir -p "$HOME"; trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done`;

/** The engine CLI's own settings: an exec's names never replace them, so a step cannot point the CLI at another daemon. */
const ENGINE_SETTINGS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_CONF'];

/** What a judge's container and its filter run with: no capability, and no way to gain one. */
const LOCKED = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

const networkOf = (key: PlaceKey): string => `${handleOf(key)}-net`;

const filterOf = (key: PlaceKey): string => `${handleOf(key)}-proxy`;

/**
 * Whether a docker of `version` keeps DNS inside an internal network: before 26.0.0, 25.0.5 and 23.0.11 it forwarded a
 * container's lookups out of it (CVE-2024-29018), which a judge could use to send what it read.
 */
function dnsStaysInside(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.trim().split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);

  return major >= 26 || (major === 25 && (minor > 0 || patch >= 5)) || (major === 23 && (minor > 0 || patch >= 11));
}

/** Seconds a stop waits before the engine kills the container, well inside COMMAND_MS. */
const STOP_GRACE = '5';

export interface Host {
  /** The member's uid and gid, which the step's processes run as on docker; undefined where the OS has none. */
  user?: { uid: number; gid: number };
  /** Whether SELinux labels the host's files, so each mount needs the shared label. */
  selinux: boolean;
  /** The environment teamai started this runtime with, the engine CLI's own. */
  env: NodeJS.ProcessEnv;
}

/** `owner`: the id of the journal whose attempts the containers are, which labels each one. */
export function containerProvider({ engine, image, owner, host }: { engine: ContainerEngine; image: string; owner: JournalId; host: Host }): Provider {
  const notInstalled = engine === 'docker'
    ? 'docker is not installed here, or not on PATH. Install Docker Desktop (https://docs.docker.com/get-docker/) or Docker Engine, start it, and start again.'
    : 'podman is not installed here, or not on PATH. Install Podman (https://podman.io/docs/installation), run `podman machine init && podman machine start` on macOS or Windows, and start again.';

  const { run: cli, why } = cliOf({ name: engine, env: host.env, notInstalled });

  const lastLine = (ran: Ran): string => (ran.kind === 'ran' ? ran.stderr.trim().split('\n').at(-1) ?? '' : '');

  const unavailable = (message: string) => ({ ok: false, failure: { code: 'sandbox_unavailable', message } }) satisfies { ok: false; failure: RuntimeFailure };

  const notRunning = (ran: Ran): string => (engine === 'docker'
    ? `docker is installed, but its daemon is not running (${lastLine(ran)}). Start Docker Desktop, or run \`sudo systemctl start docker\` on Linux, and start again.`
    : `podman cannot reach its service (${lastLine(ran)}). Run \`podman machine start\` on macOS or Windows, or check \`podman info\` on Linux, and start again.`);

  const user = (): string[] => (engine === 'podman' ? ['--userns', 'keep-id'] : host.user ? ['--user', `${host.user.uid}:${host.user.gid}`] : []);

  /** Whether the engine said the thing to create exists already, or the thing to remove does not. */
  const said = (ran: Ran, pattern: RegExp): boolean => ran.kind === 'ran' && pattern.test(ran.stderr);

  const sandboxFailed = (message: string) => ({ ok: false as const, failure: { code: 'sandbox_failed', message } });

  const find: Provider['find'] = async (key) => {
    const listed = await cli(['ps', '-a', '-q', '--filter', `label=teamai.run=${key.run}`, '--filter', `label=teamai.attempt=${key.attempt}`], { timeoutMs: COMMAND_MS });

    if (listed.kind === 'ran' && listed.code === 0) return { ok: true, id: listed.stdout.trim().split('\n').find((line) => line !== '') };

    return sandboxFailed(`${engine} could not look for the container of attempt ${key.attempt}: ${why(listed)}. Its container, if it has one, stays this attempt's until ${engine} answers again; to remove it now, run \`${engine} rm --force ${handleOf(key)}\`.`);
  };

  return {
    async offer(credentials) {
      const info = await cli(['info', '--format', engine === 'podman' ? '{{.Version.Version}}' : '{{.ServerVersion}}|{{.OperatingSystem}}']);

      if (info.kind !== 'ran') return unavailable(info.message);

      if (info.code !== 0) return unavailable(notRunning(info));
      const [version = '', system = ''] = info.stdout.trim().split('|');

      // Docker Desktop names this machine host.docker.internal in every container, and Podman host.containers.internal;
      // Docker Engine on Linux names it nothing.
      const route: HostRoute = engine === 'podman' || system === 'Docker Desktop'
        ? { ok: true, alias: engine === 'podman' ? 'host.containers.internal' : 'host.docker.internal' }
        : { ok: false, refusal: `docker reports its system as "${system}", not Docker Desktop, and teamai knows the name a container has for this machine only on Docker Desktop (host.docker.internal); Docker Engine on Linux gives it none.` };

      const present = await cli(['image', 'inspect', '--format', '{{.Id}}', image]);

      if (present.kind !== 'ran' || present.code !== 0) {
        const pulled = await cli(['pull', image]);

        if (pulled.kind !== 'ran' || pulled.code !== 0) {
          return unavailable(`${engine} could not pull image ${image} (${lastLine(pulled)}). Check its name, and that you are logged in to its registry (\`${engine} login <registry>\`), and start again.`);
        }
      }

      const probe = await cli(['run', '--rm', '--entrypoint', '/bin/sh', image, '-c', `for t in ${[...LAUNCHABLE, 'node'].join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; exit 0`]);

      if (probe.kind !== 'ran' || probe.code !== 0) return unavailable(`${engine} could not start a container from ${image} (${lastLine(probe)}). Check that it runs /bin/sh, and start again.`);
      const found = new Set(probe.stdout.split('\n').map((line) => line.trim()));
      // A login on this machine never crosses into a container: a tool is offered only on a credential teamai gives it.
      const signedIn = offerSignedIn({ tools: LAUNCHABLE.filter((tool) => found.has(tool)), provider: engine, credentials, stored: new Set() });

      if (!signedIn.ok) return signedIn;
      const { tools } = signedIn;
      // A judge's network filter runs on the image's node, so an image without it judges nothing, nor a docker that lets
      // DNS out of the judge's network. Podman judges nothing: its rootless network cannot connect the filter to it.
      const confined: ConfinedOffer[] = [];

      const judges = found.has('node') && engine === 'docker' && dnsStaysInside(version) ? tools : [];

      for (const tool of judges) {
        const access = judgeTool(tool)?.access;

        if (access === undefined) continue;
        const offer = confined.find((existing) => existing.access === access);

        if (offer) offer.tools.push(tool);
        else confined.push({ level: 'verified', access, tools: [tool] });
      }

      const can: Can = {
        workspace: WORKSPACES, isolation: 'sandbox', env: true, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true,
        ...(confined.length > 0 && { confined }),
      };

      return { ok: true, can, host: route };
    },

    find,

    async owned() {
      const listed = await cli(['ps', '-a', '--filter', `label=teamai.owner=${owner}`, '--format', '{{.ID}} {{.Label "teamai.run"}} {{.Label "teamai.attempt"}}{{.Label "teamai.judge"}}'], { timeoutMs: COMMAND_MS });

      if (!(listed.kind === 'ran' && listed.code === 0)) return sandboxFailed(`${engine} could not list the containers this runtime's journal owns: ${why(listed)}`);

      return {
        ok: true,
        sandboxes: listed.stdout.split('\n').flatMap((line) => {
          const [id, run, attempt] = line.trim().split(' ');

          return id && run && attempt ? [{ id, run, attempt }] : [];
        }),
      };
    },

    async create(key, view) {
      const mounted = mountsOf(engine, view);

      if (!mounted.ok) return mounted;
      const label = host.selinux ? ',z' : '';
      const volumes = mounted.mounts.flatMap(({ at, mode }) => ['-v', `${at}:${at}:${mode}${label}`]);

      const created = await cli([
        'run', '-d', '--name', handleOf(key), '--label', `teamai.run=${key.run}`, '--label', `teamai.attempt=${key.attempt}`, '--label', `teamai.owner=${owner}`, ...user(),
        '--env', `HOME=${CONTAINER_HOME}`, ...volumes, '--entrypoint', '/bin/sh', image, '-c', IDLE,
      ]);

      if (created.kind === 'ran' && created.code === 0) return { ok: true, id: created.stdout.trim() };
      // Another open of the same attempt created it first: that container is this attempt's.
      const existing = await find(key);

      if (existing.ok && existing.id !== undefined) return { ok: true, id: existing.id };

      return { ok: false, failure: { code: 'sandbox_failed', message: created.kind !== 'ran' ? created.message : `${engine} could not create the container for attempt ${key.attempt} from ${image}: ${lastLine(created)}` } };
    },

    judges: {
    async create(key, { dir, hosts }) {
      const existing = await find(key);

      if (!existing.ok) return existing;

      if (existing.id !== undefined) return { ok: true, id: existing.id };
      const refused = unmountable(engine, dir);

      if (refused) return { ok: false, failure: refused };

      const labels = ['--label', `teamai.run=${key.run}`, '--label', `teamai.attempt=${key.attempt}`, '--label', `teamai.owner=${owner}`];
      // No address of the host on the bridge either, so the host's own services are out of reach too.
      const network = await cli(['network', 'create', '--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true', ...labels, networkOf(key)]);

      if (!(network.kind === 'ran' && (network.code === 0 || said(network, /already exists/i)))) return sandboxFailed(`${engine} could not create the judge network ${networkOf(key)}: ${why(network)}`);
      // The filter is labelled by the run only, so the attempt's labels find its judge alone; a sweep reads its attempt
      // from teamai.judge.
      const filter = await cli(['run', '-d', '--name', filterOf(key), '--label', `teamai.run=${key.run}`, '--label', `teamai.judge=${key.attempt}`, '--label', `teamai.owner=${owner}`, ...user(), ...LOCKED, '--entrypoint', 'node', image, '-e', FILTER_SCRIPT, String(FILTER_PORT), ...hosts]);

      if (!(filter.kind === 'ran' && (filter.code === 0 || said(filter, /already in use/i)))) return sandboxFailed(`${engine} could not start the judge's network filter ${filterOf(key)}: ${why(filter)}`);
      const joined = await cli(['network', 'connect', networkOf(key), filterOf(key)]);

      if (!(joined.kind === 'ran' && (joined.code === 0 || said(joined, /already exists|already attached/i)))) return sandboxFailed(`${engine} could not connect the network filter to ${networkOf(key)}: ${why(joined)}`);
      const proxy = `http://${filterOf(key)}:${FILTER_PORT}`;

      const created = await cli([
        'run', '-d', '--name', handleOf(key), ...labels, ...user(), '--network', networkOf(key), ...LOCKED,
        '--env', `HOME=${CONTAINER_HOME}`, '--env', `HTTPS_PROXY=${proxy}`, '--env', `HTTP_PROXY=${proxy}`, '--env', 'NO_PROXY=',
        '-v', `${dir}:${EVIDENCE_DIR}:ro${host.selinux ? ',z' : ''}`, '--entrypoint', '/bin/sh', image, '-c', IDLE,
      ]);

      if (created.kind === 'ran' && created.code === 0) return { ok: true, id: created.stdout.trim() };
      const raced = await find(key);

      return raced.ok && raced.id !== undefined ? { ok: true, id: raced.id } : sandboxFailed(`${engine} could not create the judge container for attempt ${key.attempt} from ${image}: ${why(created)}`);
    },

    async release(key) {
      const filter = await cli(['rm', '--force', filterOf(key)], { timeoutMs: COMMAND_MS });

      if (!(filter.kind === 'ran' && (filter.code === 0 || said(filter, /no such container/i)))) {
        return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not remove the judge's network filter ${filterOf(key)}: ${why(filter)}. Remove it with \`${engine} rm --force ${filterOf(key)}\`.` } };
      }

      const network = await cli(['network', 'rm', networkOf(key)], { timeoutMs: COMMAND_MS });

      if (!(network.kind === 'ran' && (network.code === 0 || said(network, /not found|no such network/i)))) {
        return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not remove the judge network ${networkOf(key)}: ${why(network)}. Remove it with \`${engine} network rm ${networkOf(key)}\`.` } };
      }

      return { ok: true };
    },
    },

    async exec(id, spec, onOutput): Promise<ExecEnd> {
      const env: NodeJS.ProcessEnv = { ...host.env, ...spec.env };

      for (const setting of ENGINE_SETTINGS) env[setting] = host.env[setting];
      const withheld = spec.unset.length > 0 ? ['env', ...spec.unset.flatMap((variable) => ['-u', variable]), '--'] : [];
      const ran = await cli(['exec', '-w', spec.cwd, ...Object.keys(spec.env).flatMap((variable) => ['-e', variable]), id, ...withheld, ...spec.argv], { env, onOutput });

      return ran.kind === 'ran' ? { kind: 'exited', code: ran.code } : { kind: 'failed', failure: { code: 'exec_failed', message: ran.message } };
    },

    async stop(id) {
      const restarted = await cli(['restart', '--time', STOP_GRACE, id], { timeoutMs: COMMAND_MS });

      if (restarted.kind === 'ran' && restarted.code === 0) return { ok: true };

      return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not stop the processes in container ${id}: ${why(restarted)}. They may still run; remove the container with \`${engine} rm --force ${id}\`.` } };
    },

    async destroy(id) {
      const removed = await cli(['rm', '--force', id], { timeoutMs: COMMAND_MS });

      if (removed.kind === 'ran' && (removed.code === 0 || /no such container/i.test(removed.stderr))) return { ok: true };

      return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not remove container ${id}: ${why(removed)}. Remove it with \`${engine} rm --force ${id}\`.` } };
    },

    display: (key) => ({ label: `${handleOf(key)} (${engine})`, fields: { container: handleOf(key), image } }),

    removal: (place) => (place.confined
      ? `remove it with \`${engine} rm --force ${handleOf(place)} ${filterOf(place)}\` and \`${engine} network rm ${networkOf(place)}\``
      : `remove it with \`${engine} rm --force ${handleOf(place)}\``),
  };
}
