import path from 'node:path';
import { autoDetectInit, loadStateForScope, saveStateForScope } from './config.js';
import { reconcilePlacementRecords } from './utils/pending-push.js';
import { assertNotReadOnly } from './read-only.js';
import { pullRepo, pushRepoBranch, checkoutMaster, generateBranchName } from './utils/git.js';
import { createPrWithFallback, filterExistingTopLevelPaths } from './push.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import type { GlobalOptions, ResourceType, LocalConfig, TeamaiConfig } from './types.js';
import { askConfirmation } from './utils/prompt.js';

const REMOVABLE_TYPES: ResourceType[] = ['skills', 'rules', 'agents', 'mcp'];

export async function remove(
  type: string,
  names: string[],
  options: GlobalOptions,
): Promise<void> {
  if (!REMOVABLE_TYPES.includes(type as ResourceType)) {
    log.error(`Unsupported resource type: ${type}. Supported types: ${REMOVABLE_TYPES.join(', ')}`);
    return;
  }

  if (names.length === 0) {
    log.error('No resource names provided');
    return;
  }

  // Auto-detect scope
  const { localConfig, teamConfig } = await autoDetectInit();
  assertNotReadOnly(localConfig, 'teamai remove');

  // Single-repo mode: run the removal PR in an isolated knowledge worktree so the
  // branch/commit never touches the user's active tree.
  if (localConfig.repo.kind === 'self') {
    const { withKnowledgeWorktree, EmptyRepoError } = await import('./utils/reports-branch.js');
    try {
      await withKnowledgeWorktree(localConfig, (wtConfig) => removeCore(type, names, options, wtConfig, teamConfig));
    } catch (e) {
      if (e instanceof EmptyRepoError) {
        log.error(e.message);
      } else {
        log.error(`Remove failed: ${(e as Error).message}`);
      }
    }
    return;
  }

  await removeCore(type, names, options, localConfig, teamConfig);
}

/**
 * Drop the placement record of each removed resource.
 *
 * `remove` accepts both spellings — the published `<ns>/<name>` and the bare
 * `<name>` the author's own copy carries — and the record is always keyed by
 * the bare one, so the key comes from the basename. The recorded path still has
 * to match the resource being removed, or removing `other-ns/my-rule` would
 * drop the record of a `my-rule` that lives somewhere else entirely.
 *
 * Existence is deliberately NOT the test: the removal only exists on the push
 * branch until its PR merges, and `removeCore` checks the default branch back
 * out before this runs, so the file is still on disk at this point.
 */
function dropPlacementRecords(
  records: Record<string, string> | undefined,
  removed: string[],
  teamPathsFor: (publishedName: string) => string[],
): void {
  if (!records) return;
  for (const name of removed) {
    const key = path.basename(name);
    const recorded = records[key];
    if (recorded && teamPathsFor(name).includes(recorded)) delete records[key];
  }
}

async function removeCore(
  type: string,
  names: string[],
  options: GlobalOptions,
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
): Promise<void> {
  const selfMode = localConfig.repo.kind === 'self';

  // Pull latest before making changes. In self mode the worktree is already a
  // fresh checkout of origin/<default>, so skip the pull.
  if (!selfMode) {
    try {
      await pullRepo(localConfig.repo.localPath);
    } catch { /* continue even if pull fails */ }
  }

  // `publishedNameFor` below resolves the bare name the author types through
  // the placement record, and a placement becomes a record only once it has
  // landed on the default branch — which this may be the first command to see.
  try {
    const recordsState = await loadStateForScope(localConfig);
    if (await reconcilePlacementRecords(localConfig.repo.localPath, recordsState)) {
      await saveStateForScope(recordsState, localConfig);
    }
  } catch (e) {
    log.debug(`Placement record cleanup skipped: ${(e as Error).message}`);
  }

  const handler = getHandler(type as ResourceType);

  // Verify which resources exist
  const teamItems = await handler.scanTeamForPull(teamConfig, localConfig);
  const localItems = await handler.scanLocalForPush(teamConfig, localConfig);
  const allNames = new Set([...teamItems.map((i) => i.name), ...localItems.map((i) => i.name)]);

  const found: string[] = [];
  const notFound: string[] = [];
  for (const name of names) {
    // The placement record is consulted FIRST. A resource this machine placed
    // in a namespace is published as `<ns>/<name>`, while the author's local
    // copy — and so the name they type — is the bare one; and the LOCAL scan
    // contributes that bare name whenever their copy has edits. Taking the
    // bare match would delete the local copy, report success, and leave the
    // namespaced team file published (#649 review).
    const published = await handler.publishedNameFor(name, localConfig);
    if (published) {
      // Not cross-checked against `allNames`: `publishedNameFor` has already
      // proved the file is in the team repo, and the scans do not all spell a
      // namespaced resource the same way — `scanTeamForPull` reports an agent
      // by its bare stem, so requiring membership here silently fell back to
      // the bare name and removed that agent from EVERY namespace (#649 review).
      log.info(`${name} was published as ${published}`);
      found.push(published);
      continue;
    }
    if (allNames.has(name)) {
      found.push(name);
    } else {
      notFound.push(name);
    }
  }

  if (notFound.length > 0) {
    log.warn(`Not found (skipping): ${notFound.join(', ')}`);
  }

  if (found.length === 0) {
    log.error('No matching resources found to remove');
    log.info(`Available ${type}:`);
    for (const n of [...allNames].sort()) {
      console.log(`  - ${n}`);
    }
    return;
  }

  // Show what will be removed
  console.log('');
  console.log(`Will remove ${found.length} ${type}:`);
  for (const name of found) {
    console.log(`  - ${name}`);
  }
  console.log('');
  console.log('From: team repo + all local AI tool directories');
  console.log('');

  if (options.dryRun) {
    log.info('Dry run — no changes made');
    return;
  }

  // `askConfirmation` returns false without a TTY, so a scripted run can only
  // get past this prompt through `--force` (issue #591). Same shape as the
  // uninstall prompt, so the two stay refactorable together.
  if (!options.force) {
    const confirmed = await askConfirmation('Are you sure? [y/N] ');
    if (!confirmed) {
      log.info('Cancelled');
      return;
    }
  }

  const spin = spinner(`Removing ${found.length} ${type}...`).start();

  // Remove all resources
  let totalRemoved = 0;
  for (const name of found) {
    const removedPaths = await handler.removeItem(name, teamConfig, localConfig);
    totalRemoved += removedPaths.length;
  }

  // Refresh marketplace.json if skills were removed
  if (type === 'skills') {
    try {
      const { refreshMarketplace } = await import('./resources/marketplace.js');
      const updated = await refreshMarketplace(localConfig.repo.localPath);
      if (updated) {
        log.debug('Refreshed marketplace.json after skill removal');
      }
    } catch (e) {
      log.debug(`Marketplace refresh skipped: ${(e as Error).message}`);
    }
  }

  if (totalRemoved === 0) {
    spin.fail('Nothing was removed');
    return;
  }

  // Git commit and push via a single branch + MR
  try {
    const branchName = generateBranchName(localConfig.username);
    const nameList = found.length <= 3
      ? found.map((n) => `"${n}"`).join(', ')
      : `${found.slice(0, 3).map((n) => `"${n}"`).join(', ')} and ${found.length - 3} more`;
    const commitMsg = `[teamai] Remove ${found.length} ${type}: ${nameList} by ${localConfig.username}`;

    const candidateDirs = [`${type}/`, 'rules/', '.codebuddy-plugin/'];
    const gitFiles = await filterExistingTopLevelPaths(
      localConfig.repo.localPath,
      candidateDirs,
    );
    const hasChanges = await pushRepoBranch(
      localConfig.repo.localPath,
      commitMsg,
      gitFiles,
      branchName,
    );

    if (!hasChanges) {
      spin.succeed('No changes to push');
    } else {
      spin.succeed(`Removed ${found.length} ${type} from ${totalRemoved} location(s)`);

      // Create PR/MR via provider (shared helper — DRY)
      await createPrWithFallback(
        teamConfig,
        localConfig,
        branchName,
        commitMsg,
        `Remove ${found.length} ${type}: ${nameList}`,
      );

      // Switch back to master after PR creation
      await checkoutMaster(localConfig.repo.localPath);
    }
  } catch (e) {
    spin.fail(`Git push failed: ${(e as Error).message}`);
    return;
  }

  // Clean up state tracking
  const state = await loadStateForScope(localConfig);
  if (type === 'skills') {
    state.pushedSkills = state.pushedSkills.filter((s) => !found.includes(s));
  }
  if (type === 'rules') {
    state.pushedRules = state.pushedRules.filter((r) => !found.includes(r));
    // A record left behind would send the author's local copy back to a path
    // that is about to stop existing.
    dropPlacementRecords(state.placedRules, found, (n) => [`rules/${n}.md`]);
  }
  if (type === 'agents') {
    dropPlacementRecords(state.placedAgents, found, (n) => [`agents/${n}.yaml`, `agents/${n}.md`]);
  }
  // `wiki` is not tracked in pushedX state; nothing to clean here.
  await saveStateForScope(state, localConfig);
}
