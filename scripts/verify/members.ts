/**
 * The world's other installs: its project's bare origin, made on first need, and each member with a HOME, a TMPDIR and
 * a clone of its own. What this setup changes in the world is moved into the baseline, so it leaves no LEAK; what teamai
 * changes afterwards is judged as before.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitconfigText, saveWorld, shortTmpRoot, TEAM_URL, teamRefs, worldFiles, worldTmpDir, type Member, type World } from './world.js';

/** A member's name: a path segment, a hostname and a container name alike. */
export const MEMBER_NAME = /^[a-z][a-z0-9-]{0,11}$/;

/** The project's origin, a fake https URL as the team repo's is, which each HOME's git maps onto the bare repo. */
export const ORIGIN_URL = 'https://teamai.test/world/project.git';

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

/** Adds member `name` on this machine: a HOME, a TMPDIR and a clone of the origin, the world's origin made first if it has none. */
export function addMember(world: World, { name }: { name: string }): World {
  if (!MEMBER_NAME.test(name)) throw new Error(`${name} is not a member name: a lowercase letter, then up to 11 lowercase letters, digits or dashes.`);

  if (world.members?.some((member) => member.name === name)) throw new Error(`World ${world.runId} already has member ${name}.`);
  const withOrigin = ensureOrigin(world);
  const { origin } = withOrigin;

  if (origin === undefined) throw new Error(`World ${world.runId} has no origin after it was made.`);
  const layout = memberLayout(withOrigin, { name, tmpRoot: shortTmpRoot() });
  fs.mkdirSync(layout.home, { recursive: true });
  fs.mkdirSync(layout.tmp, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.home, '.gitconfig'), gitconfigText({ name, email: `${name}@teamai.test`, urls: [{ repo: withOrigin.team, url: TEAM_URL }, { repo: origin.bare, url: ORIGIN_URL }] }));
  const env = { ...frozenEnv(withOrigin), HOME: layout.home, USERPROFILE: layout.home, TMPDIR: layout.tmp };
  setupGit(env, ['clone', '--quiet', ORIGIN_URL, layout.project], layout.root);

  const { root: _root, ...own } = layout;
  const member: Member = { machine: 'host', name, ...own, env, baseline: { files: worldFiles(layout) } };
  const next: World = { ...withOrigin, members: [...withOrigin.members ?? [], member] };
  saveWorld(next);

  return next;
}
