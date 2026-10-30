/**
 * Plan's check of an arm's `team: { without: paths }`, before any run exists: each path is a file or directory of the
 * arm's team revision whose leaving out changes what its trials get, by the namespace rule delivery follows. Each
 * resource type keeps its shared items under its root, `<root>/<item>`, and a namespace's under `<root>/<ns>/<item>`,
 * delivered only where a role or project the member holds receives `<ns>`, in place of the shared item of its name.
 */
import { isNestedPlaceableType, NAMESPACE_AXIS, PLACEABLE_TYPES, type PlaceableType } from '../push-namespaces.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { LocalConfig } from '../types.js';
import { loadTagsConfig } from '../utils/tags.js';
import { withTeamRevision } from '../workflow/cache.js';
import { git } from '../workflow/worktree.js';

/** Why plan refuses the arm: git could not read its team revision, or a path names nothing its trials would get. */
type Refusal = { code: 'arm_team_unreadable' | 'arm_team_unresolved'; message: string };

/** The namespaces the member receives at the revision, as delivery resolves them; null when every one is delivered. */
type Received = Awaited<ReturnType<typeof resolveResourceNamespaces>>;

/** Types whose files hold entries, each an item of its own, so a namespace's file adds to the shared one, never replaces it. */
const ENTRY_TYPES: ReadonlySet<PlaceableType> = new Set<PlaceableType>(['env', 'hooks', 'mcp', 'models']);

const REMOVE = 'Remove it from the arm\'s team, push it, run teamai pull, and start again.';

/**
 * Why plan refuses arm `arm` that runs without `paths` at team commit `revision`, for the member `config` names, or
 * undefined when its trials can run without them. Refused: a path the revision does not have; teamai.yaml, which the
 * clone's pull reads; a path in a namespace the member's roles and projects do not receive; a rule the tags the member
 * subscribes leave out; a shared skill they receive
 * no subscribed tag of, as roles and projects deliver shared skills only through tags; and a shared path that a
 * namespace they receive would still deliver in its place, unless the arm runs without that one too.
 */
export async function withoutRefusal(config: LocalConfig, { arm, paths, revision }: { arm: string; paths: readonly string[]; revision: string }): Promise<Refusal | undefined> {
  const short = revision.slice(0, 7);
  const listed = await git(config.repo.localPath, ['ls-tree', '-r', '-z', '--name-only', revision]);
  if (listed.code !== 0) {
    return { code: 'arm_team_unreadable', message: `Arm "${arm}" runs without ${paths.join(', ')}, and git could not list team revision ${short} at ${config.repo.localPath}: ${listed.stderr.trim()}. Repair the team repo, or run teamai pull, and start again.` };
  }
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  const missing = paths.find((one) => !files.some((file) => leavesOut([one], file)));
  if (missing !== undefined) {
    return { code: 'arm_team_unresolved', message: `Arm "${arm}" runs without ${missing}, which team revision ${short} does not have. Fix the arm's team, push it, run teamai pull, and start again.` };
  }
  if (paths.includes('teamai.yaml')) {
    return { code: 'arm_team_unresolved', message: `Arm "${arm}" runs without teamai.yaml, which teamai pull reads to install the team, so no trial could run. ${REMOVE}` };
  }
  const read = await withTeamRevision(config, revision, async (at) => {
    const tags = await loadTagsConfig(at.repo.localPath);
    const subscribed = new Set(at.subscribedTags ?? []);
    const named = (items: Record<string, string[]> | undefined, brought: boolean): Set<string> => new Set(Object.entries(items ?? {}).flatMap(([name, itemTags]) => (itemTags.some((tag) => subscribed.has(tag)) === brought ? [name] : [])));
    // With no subscription, the tag channel leaves no rule out.
    return { received: await resolveResourceNamespaces(at), tagged: named(tags?.skills, true), tagSkipped: subscribed.size > 0 ? named(tags?.rules, false) : new Set<string>() };
  });
  if ('failed' in read) {
    return { code: 'arm_team_unreadable', message: `Arm "${arm}" runs without ${paths.join(', ')}, and the namespaces its roles and projects receive at team revision ${short} could not be read: ${read.failed}. Repair the team repo, or run teamai pull, and start again.` };
  }
  for (const one of paths) {
    const message = namespaceProblem({ arm, path: one, paths, files, ...read });
    if (message !== undefined) return { code: 'arm_team_unresolved', message };
  }
  return undefined;
}

/** Whether running without `paths` leaves out `file`: one of them is that path, or a directory that holds it. */
export function leavesOut(paths: readonly string[], file: string): boolean {
  return paths.some((listed) => file === listed || file.startsWith(`${listed}/`));
}

/** The directory each type keeps its items under in the team repo. */
function rootOf(type: PlaceableType): string {
  return type === 'wiki' ? 'teamwiki/evidence/code' : type;
}

/**
 * Why leaving out `path` would change nothing the member gets, by the namespace it is in, a shared skill no tag brings
 * the member, or the namespace item that replaces it, or undefined. A path under no type's root, or a whole root, is in
 * no namespace. `tagged`: the shared skills a tag the member subscribes brings; `tagSkipped`: the rules, by name, the
 * tags the member subscribes leave out.
 */
function namespaceProblem(input: { arm: string; path: string; paths: readonly string[]; files: readonly string[]; received: Received; tagged: ReadonlySet<string>; tagSkipped: ReadonlySet<string> }): string | undefined {
  const { arm, path, paths, files, received, tagged, tagSkipped } = input;
  const type = PLACEABLE_TYPES.find((one) => path.startsWith(`${rootOf(one)}/`));
  if (type === undefined) return undefined;
  const root = rootOf(type);
  const item = path.slice(root.length + 1);
  const [first = ''] = item.split('/');
  const isDirectory = (dir: string): boolean => files.some((file) => file.startsWith(`${dir}/`));
  const isNamespace = (segment: string): boolean => namespaceSegment({ type, segment, files, received, isDirectory });
  const active = received === null ? undefined : received.activeNamespaces[NAMESPACE_AXIS[type]] ?? [];
  const namespaced = isNamespace(first);
  if (namespaced && active !== undefined && !active.includes(first)) {
    return `Arm "${arm}" runs without ${path}, which is in namespace ${first}, and the arm's roles or projects don't receive ${first}, so leaving it out changes nothing. ${REMOVE}`;
  }
  if (type === 'rules' && tagSkipped.has(item.replace(/\.md$/, ''))) {
    return `Arm "${arm}" runs without ${path}, a rule tagged only with tags the member does not subscribe, so pull leaves it out already and leaving it out changes nothing. ${REMOVE}`;
  }
  if (namespaced) return undefined;
  if (type === 'skills' && active !== undefined && !tagged.has(first)) {
    return `Arm "${arm}" runs without ${path}, a shared skill, which the arm's roles or projects receive only through a subscribed tag, and none brings it, so leaving it out changes nothing. ${REMOVE}`;
  }
  if (ENTRY_TYPES.has(type)) return undefined;
  // Every namespace of the type is delivered when no role or project filters the member.
  const delivering = active ?? [...new Set(files.flatMap((file) => (file.startsWith(`${root}/`) ? [file.slice(root.length + 1).split('/')[0] ?? ''] : [])))].filter(isNamespace);
  for (const namespace of delivering) {
    const inPlace = replacementOf({ type, root, namespace, item, files });
    if (inPlace !== undefined && !leavesOut(paths, inPlace)) {
      return `Arm "${arm}" runs without ${path}, but its namespace ${namespace} delivers ${inPlace} in its place; list ${inPlace} too.`;
    }
  }
  return undefined;
}

/**
 * Whether `segment`, the first directory under a type's root, is a namespace rather than shared content: for skills, a
 * directory with no SKILL.md of its own; for types that nest freely, one a role or project declares; for any other
 * type, any directory.
 */
function namespaceSegment(input: { type: PlaceableType; segment: string; files: readonly string[]; received: Received; isDirectory: (dir: string) => boolean }): boolean {
  const { type, segment, files, received, isDirectory } = input;
  const dir = `${rootOf(type)}/${segment}`;
  if (type === 'skills') return isDirectory(dir) && !files.includes(`${dir}/SKILL.md`);
  if (!isNestedPlaceableType(type) && type !== 'scorers') return isDirectory(dir);
  if (received === null) return type === 'scorers' && isDirectory(dir);
  const inactive: Partial<Record<PlaceableType, readonly string[]>> = {
    docs: received.inactiveDocsNamespaces, wiki: received.inactiveWikiNamespaces, prompts: received.inactivePromptsNamespaces, scorers: received.inactiveScorersNamespaces,
  };
  return [...(received.activeNamespaces[NAMESPACE_AXIS[type]] ?? []), ...(inactive[type] ?? [])].includes(segment);
}

/**
 * What namespace `namespace` delivers in place of the shared `item` of `type`, or undefined: the same path there, or,
 * for a type whose items are files named by their stem, a file of that stem, as an agent may be .md or .yaml.
 */
function replacementOf({ type, root, namespace, item, files }: { type: PlaceableType; root: string; namespace: string; item: string; files: readonly string[] }): string | undefined {
  const there = `${root}/${namespace}/${item}`;
  if (type === 'skills' || isNestedPlaceableType(type)) return files.some((file) => leavesOut([there], file)) ? there : undefined;
  const stem = (file: string): string => file.replace(/\.[^./]+$/, '');
  return files.find((file) => file.startsWith(`${root}/${namespace}/`) && stem(file) === stem(there));
}
