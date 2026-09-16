import type { LocalConfig } from './types.js';
import { loadRolesManifest, resolveRoleResourceNamespaces, type ResourceNamespaces } from './roles.js';
import { loadProjectsManifest, resolveProjectResourceNamespaces, mergeNamespaces } from './projects.js';
import { log } from './utils/logger.js';

/** Resolve the same role/project activation policy for resource pull and push. */
export async function resolveResourceNamespaces(localConfig: LocalConfig) {
  const activeProjects = localConfig.projects ?? [];
  const primaryRole = localConfig.primaryRole;
  const hasRole = !!primaryRole;
  const hasProjects = activeProjects.length > 0;

  // Load the projects manifest up front: its mere existence means this team uses
  // project partitioning, which changes the "no active filter" semantics below.
  const projectsManifest = await loadProjectsManifest(localConfig.repo.localPath);
  const teamHasProjects = !!projectsManifest && projectsManifest.projects.length > 0;

  // When there is nothing to filter by AND the team does not use project
  // partitioning, keep the legacy unfiltered behavior (null = sync everything).
  //
  // But if the team HAS a projects manifest, a directory with no active project
  // is NOT the same as a pre-project legacy config: deactivating projects (via
  // `teamai projects set` with no ids) must scope down to role-only + shared
  // resources and CLEAN UP the resources of the projects it left — never fall
  // through to an unfiltered sync that reinstalls every project's skills/rules.
  // So we return a real (possibly empty-active) context and let the cleanup path
  // below prune the now-inactive project namespaces.
  if (!hasRole && !hasProjects && !teamHasProjects) return null;

  // ── Role namespaces (optional) ──
  let roleNamespaces: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: [] };
  let allRoleSkillNamespaces = new Set<string>();
  if (primaryRole) {
    let rolesManifest;
    try {
      rolesManifest = await loadRolesManifest(localConfig.repo.localPath);
    } catch {
      log.warn('Could not load roles manifest. Skipping role-based filtering.');
      rolesManifest = null;
    }
    if (rolesManifest) {
      try {
        roleNamespaces = resolveRoleResourceNamespaces({
          manifest: rolesManifest,
          primaryRole,
          additionalRoles: localConfig.additionalRoles ?? [],
        });
        allRoleSkillNamespaces = new Set(rolesManifest.roles.flatMap((role) => role.resources.skills));
      } catch {
        log.warn(`Role "${localConfig.primaryRole}" not found in manifest. Falling back to unfiltered sync.`);
        log.warn('Run `teamai roles set <role>` to pick a valid role.');
        // A misconfigured role, with nothing else to scope by, can't filter safely.
        if (!hasProjects && !teamHasProjects) return null;
      }
    } else if (!hasProjects && !teamHasProjects) {
      return null;
    }
  }

  // ── Project namespaces ──
  // Populate the full set of project skill namespaces from the manifest whenever
  // the team defines projects — even with none active — so every non-selected
  // project namespace is treated as inactive and cleaned up below. The ACTIVE
  // namespaces come only from the projects this directory selected.
  let projectNamespaces: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: [] };
  let allProjectSkillNamespaces = new Set<string>();
  if (projectsManifest) {
    allProjectSkillNamespaces = new Set(projectsManifest.projects.flatMap((p) => p.resources.skills));
    if (hasProjects) {
      try {
        projectNamespaces = resolveProjectResourceNamespaces({
          manifest: projectsManifest,
          activeProjects,
        });
      } catch (e) {
        log.warn(`${e instanceof Error ? e.message : String(e)} Falling back to role-only filtering.`);
      }
    }
  } else if (hasProjects) {
    log.warn('Active projects configured but no projects manifest found. Skipping project-based filtering.');
  }

  const activeNamespaces = mergeNamespaces(roleNamespaces, projectNamespaces);

  // Skill activation set spans BOTH dimensions: a skill is inactive only if it
  // lives in a namespace that neither an active role nor an active project selects.
  const allSkillNamespaces = new Set<string>([...allRoleSkillNamespaces, ...allProjectSkillNamespaces]);
  return { activeNamespaces, allSkillNamespaces };
}
