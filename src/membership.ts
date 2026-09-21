import { activeRoleIds, listRoleIds, loadRolesManifest } from './roles.js';
import { activeProjectIds, listProjectIds, loadProjectsManifest } from './projects.js';
import { log } from './utils/logger.js';

/**
 * The two membership axes TeamAI resolves delivery on, for THIS member in THIS
 * directory. Roles come from `primaryRole` + `additionalRoles`; projects from
 * the directory's `projects` list.
 *
 * `null` on an axis means "this member has not configured that axis", which
 * matches every entry scoped on it — the same unfiltered fallback skills and
 * rules use. It is deliberately not the same as `[]`: an axis the member has
 * configured as empty cannot occur (see `activeRoleIds` / `activeProjectIds`,
 * both of which collapse an empty list to `null`), but an *entry* scoped with
 * an empty list reaches nobody.
 */
export type Membership = {
  roles: string[] | null;
  projects: string[] | null;
};

/** An entry (hook, MCP server, env variable) that may restrict either axis. */
export type MembershipScope = {
  roles?: string[];
  projects?: string[];
};

/**
 * Both membership axes for this member, resolved once per run. Each axis is
 * read by the module that owns it, so this adds no third spelling of either.
 */
export function resolveMembership(
  localConfig: { primaryRole?: string; additionalRoles?: string[]; projects?: string[] },
): Membership {
  return {
    roles: activeRoleIds(localConfig),
    projects: activeProjectIds(localConfig),
  };
}

/**
 * Does one axis of an entry apply to this member? Omitted = everyone, an empty
 * list = nobody, and a null active set (axis not configured) matches everything.
 * Mirrors the `tools:` filter.
 */
function matchesAxis(entryKeys: string[] | undefined, active: string[] | null): boolean {
  if (!entryKeys || active == null) return true;
  return entryKeys.some((key) => active.includes(key));
}

/**
 * Does an entry with optional `roles:` and `projects:` lists apply to this
 * member? The two axes compose as AND: a `roles: [frontend] projects: [checkout]`
 * entry reaches frontend members of checkout, not everyone on either.
 *
 * That is the same composition `tools:` and `roles:` already have, and it is
 * deliberately NOT the union that `mergeNamespaces` applies to role and project
 * resource namespaces — which answers the different question of which
 * directories to sync, rather than filtering one entry.
 *
 * One call covers both axes so a delivery path cannot filter on one and forget
 * the other.
 */
export function matchesMembership(entry: MembershipScope, membership: Membership): boolean {
  return matchesAxis(entry.roles, membership.roles) && matchesAxis(entry.projects, membership.projects);
}

/** `${file}:${axis}:${id}` pairs already reported in this process (pull runs each
 *  reconciler once per scope; the member should read the warning once). */
const reportedUnknownIds = new Set<string>();

/** Test seam: clear the once-per-process warning memory. */
export function __resetMembershipWarnings(): void {
  reportedUnknownIds.clear();
}

function warnOnce(dedupeKey: string, message: string): void {
  if (reportedUnknownIds.has(dedupeKey)) return;
  reportedUnknownIds.add(dedupeKey);
  log.warn(message);
}

/**
 * Warn once per pull for each id that an entry's `roles:` or `projects:` names
 * but the matching manifest does not define. A typo would otherwise ship the
 * entry to nobody in silence. Never fails the run: without a readable manifest
 * there is nothing to check against.
 *
 * The projects axis has one case the roles axis cannot have: a team with no
 * `manifest/projects.yaml` at all (or one defining zero projects). Every member
 * then has a null projects axis, so a `projects:` key restricts nothing and the
 * entry ships to everyone. That is reported with its own wording — there is no
 * valid-id list to suggest, and the mistake is a missing manifest rather than a
 * misspelled id.
 */
export async function warnUnknownMembershipIds(
  repoPath: string,
  file: string,
  entries: Array<{ kind: string; name: string } & MembershipScope>,
): Promise<void> {
  const scoped = entries.filter((entry) => entry.roles?.length || entry.projects?.length);
  if (scoped.length === 0) return;

  if (scoped.some((entry) => entry.roles?.length)) {
    let knownRoles: Set<string> | null = null;
    try {
      knownRoles = new Set(listRoleIds(await loadRolesManifest(repoPath)));
    } catch {
      knownRoles = null;
    }
    if (knownRoles) {
      for (const entry of scoped) {
        for (const role of entry.roles ?? []) {
          if (knownRoles.has(role)) continue;
          warnOnce(
            `${file}:roles:${role}`,
            `roles: unknown role id "${role}" in ${file} ${entry.kind} "${entry.name}". Valid roles: ${[...knownRoles].join(', ')}`,
          );
        }
      }
    }
  }

  const projectScoped = scoped.filter((entry) => entry.projects?.length);
  if (projectScoped.length === 0) return;

  const manifest = await loadProjectsManifest(repoPath).catch(() => null);
  const knownProjects = manifest ? listProjectIds(manifest) : [];
  if (knownProjects.length === 0) {
    warnOnce(
      `${file}:projects:<no-manifest>`,
      `projects: manifest/projects.yaml defines no projects, so "projects:" on ${projectScoped.length} ${file} `
      + `${projectScoped.length === 1 ? 'entry' : 'entries'} restricts nothing — they are delivered to every member. `
      + 'Define the projects there, or drop the key.',
    );
    return;
  }

  const known = new Set(knownProjects);
  for (const entry of projectScoped) {
    for (const project of entry.projects ?? []) {
      if (known.has(project)) continue;
      warnOnce(
        `${file}:projects:${project}`,
        `projects: unknown project id "${project}" in ${file} ${entry.kind} "${entry.name}". Valid projects: ${knownProjects.join(', ')}`,
      );
    }
  }
}
