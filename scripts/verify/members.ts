/**
 * The world's other installs: its project's bare origin, made on first need, and each member with a HOME, a TMPDIR and
 * a clone of its own. What this setup changes in the world is moved into the baseline, so it leaves no LEAK; what teamai
 * changes afterwards is judged as before.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitconfigText, saveWorld, shortTmpRoot, TEAM_URL, teamRefs, worldFiles, worldTmpDir, type Member, type World } from './world.js';

/** A member's name: a path segment, a hostname and a container name alike. */
export const MEMBER_NAME = /^[a-z][a-z0-9-]{0,11}$/;

/** The project's origin, a fake https URL as the team repo's is, which each HOME's git maps onto the bare repo. */
export const ORIGIN_URL = 'https://teamai.test/world/project.git';

/** `--machine host|container` among `member`'s flags: host unless it names container. */
export function parseMachine(flags: readonly string[]): 'host' | 'container' {
  const at = flags.findIndex((flag) => flag === '--machine' || flag.startsWith('--machine='));
  const value = at === -1 ? 'host' : flags[at]?.startsWith('--machine=') ? flags[at]?.slice('--machine='.length) : flags[at + 1];
  const rest = at === -1 ? flags : flags.filter((_, i) => i !== at && (i !== at + 1 || flags[at]?.startsWith('--machine=')));

  if (rest.length > 0) throw new Error(`member does not take ${rest.join(' ')}.`);

  if (value !== 'host' && value !== 'container') throw new Error(`--machine takes host or container, not ${value ?? 'nothing'}.`);

  return value;
}

/** Where member `name` keeps what is its own. */
export function memberLayout(world: Pick<World, 'dir' | 'runId'>, { name, tmpRoot }: { name: string; tmpRoot: string }) {
  const root = path.join(world.dir, 'members', name);

  return { root, home: path.join(root, 'home'), project: path.join(root, 'project'), writers: path.join(root, 'writers.json'), tmp: worldTmpDir({ root: tmpRoot, runId: world.runId, member: name }) };
}

/** `baseline` with every entry the harness's own setup changed between `before` and `after` taken as it left it. */
export function setupBaseline(baseline: Readonly<Record<string, string>>, before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>) {
  const next = Object.fromEntries(Object.entries(baseline));

  for (const entry of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[entry] === after[entry]) continue;
    const value = after[entry];

    if (value === undefined) delete next[entry];
    else next[entry] = value;
  }

  return next;
}

/** Runs git as the world's setup does: with `env`, its output kept unless it fails. */
function setupGit(env: Record<string, string>, args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
}

function frozenEnv(world: World): Record<string, string> {
  if (world.env === undefined) throw new Error(`World ${world.runId} was made before members existed. Make a new world.`);

  return world.env;
}

/** Gives the world's project a bare origin behind ORIGIN_URL, once, with main pushed; answers the world as it is now. */
export function ensureOrigin(world: World): World {
  if (world.origin !== undefined) return world;
  const env = frozenEnv(world);
  const bare = path.join(world.dir, 'origin.git');
  const before = worldFiles(world);

  setupGit(env, ['init', '--quiet', '--bare', bare], world.dir);
  fs.writeFileSync(path.join(world.home, '.gitconfig'), gitconfigText({ name: 'TeamAI World', email: 'world@teamai.test', urls: [{ repo: world.team, url: TEAM_URL }, { repo: bare, url: ORIGIN_URL }] }));
  setupGit(env, ['remote', 'add', 'origin', ORIGIN_URL], world.project);
  setupGit(env, ['push', '--quiet', '-u', 'origin', 'HEAD:main'], world.project);

  const files = setupBaseline(world.baseline.files ?? before, before, worldFiles(world));
  const next: World = { ...world, origin: { bare, url: ORIGIN_URL, refs: teamRefs(bare) }, baseline: { ...world.baseline, files } };
  saveWorld(next);

  return next;
}

/** The image a container member runs: Node as on this machine, with git, procps and bubblewrap, as the Linux kit's base. */
function machineImage(): string {
  const major = process.versions.node.split('.')[0] ?? '22';
  const image = `teamai-verify-machine:node${major}`;

  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0) return image;
  const dockerfile = `FROM node:${major}\nRUN apt-get update -qq && apt-get install -y -qq git procps bubblewrap >/dev/null && rm -rf /var/lib/apt/lists/*\n`;
  const built = spawnSync('docker', ['build', '-q', '-t', image, '-'], { input: dockerfile, encoding: 'utf8' });

  if (built.status !== 0) throw new Error(`The container member's image ${image} could not be built: ${built.stderr.trim().split('\n').at(-1) ?? ''}. Start Docker, or add the member without --machine container.`);

  return image;
}

/** The world's packed teamai, installed in a Linux container named `container` that has the world's paths at the same place. */
function startMachine(world: World, { container, hostname, tmp }: { container: string; hostname: string; tmp: string }): void {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const run = spawnSync('docker', ['run', '-d', '--name', container, '--hostname', hostname, '--label', `teamai.verify.world=${world.runId}`, '--user', `${uid}:${gid}`, '--init', '-v', `${world.dir}:${world.dir}`, '-v', `${tmp}:${tmp}`, '--entrypoint', 'sleep', machineImage(), 'infinity'], { encoding: 'utf8' });

  if (run.status !== 0) throw new Error(`The container member's container ${container} did not start: ${run.stderr.trim()}`);
  const install = spawnSync('docker', ['exec', '-u', '0', container, 'sh', '-c', `npm install --prefix ${CONTAINER_TEAMAI} --no-audit --no-fund --silent "$1" && chown -R ${uid}:${gid} ${CONTAINER_TEAMAI}`, 'sh', world.build.tarball], { encoding: 'utf8' });

  if (install.status !== 0) throw new Error(`teamai could not be installed in ${container}: ${install.stderr.trim().split('\n').at(-1) ?? ''}`);
}

/** Where a container member's teamai is installed: inside the container, never in the world's directory. */
const CONTAINER_TEAMAI = '/opt/teamai';

/** The name of member `name`'s container: the harness makes and removes only containers it named so. */
export function machineName(world: Pick<World, 'runId'>, name: string): string {
  return `teamai-verify-${world.runId}-${name}`;
}

/**
 * Adds member `name`: a HOME, a TMPDIR and a clone of the origin, the world's origin made first if it has none. With
 * `machine: 'container'`, its commands run in a Linux container of its own, with its own hostname and process table.
 */
export function addMember(world: World, { name, machine = 'host' }: { name: string; machine?: 'host' | 'container' }): World {
  if (!MEMBER_NAME.test(name)) throw new Error(`${name} is not a member name: a lowercase letter, then up to 11 lowercase letters, digits or dashes.`);

  if (world.members?.some((member) => member.name === name)) throw new Error(`World ${world.runId} already has member ${name}.`);
  const withOrigin = ensureOrigin(world);
  const { origin } = withOrigin;

  if (origin === undefined) throw new Error(`World ${world.runId} has no origin after it was made.`);
  const layout = memberLayout(withOrigin, { name, tmpRoot: shortTmpRoot() });
  fs.mkdirSync(layout.home, { recursive: true });
  fs.mkdirSync(layout.tmp, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.home, '.gitconfig'), gitconfigText({ name, email: `${name}@teamai.test`, urls: [{ repo: withOrigin.team, url: TEAM_URL }, { repo: origin.bare, url: ORIGIN_URL }] }));
  const hostEnv = { ...frozenEnv(withOrigin), HOME: layout.home, USERPROFILE: layout.home, TMPDIR: layout.tmp };
  setupGit(hostEnv, ['clone', '--quiet', ORIGIN_URL, layout.project], layout.root);
  const container = machineName(withOrigin, name);

  if (machine === 'container') startMachine(withOrigin, { container, hostname: name, tmp: layout.tmp });
  const env = machine === 'container' ? { ...hostEnv, PATH: `${CONTAINER_TEAMAI}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin` } : hostEnv;

  const { root: _root, ...own } = layout;
  const place = { name, ...own, env, baseline: { files: worldFiles(layout) } };
  const member: Member = machine === 'container' ? { machine: 'container', container, ...place } : { machine: 'host', ...place };
  const next: World = { ...withOrigin, members: [...withOrigin.members ?? [], member] };
  saveWorld(next);

  return next;
}
