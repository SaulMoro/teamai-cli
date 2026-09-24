import { requireInit, detectProjectConfig } from './config.js';
import { pullRepo } from './utils/git.js';
import { pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { EnvHandler, maskEnvValue, ENV_KEY_RE, envEntryReader } from './resources/env.js';
import { describeEntryFailure, describeOrigin, entryFileAbsolutePath, entryFilePath, entryNamespaceFromFlags, resolveEntriesFor } from './namespaced-entries.js';
import type { GlobalOptions } from './types.js';
import { isSelfMode } from './types.js';

const envHandler = new EnvHandler();

/**
 * List the team env variables this directory receives: env/env.yaml plus the
 * active env/<ns>/env.yaml files, each with the namespace it comes from.
 *
 * By default, values are masked. Pass `reveal: true` to show plaintext.
 */
export async function envList(options: GlobalOptions & { reveal?: boolean }): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;

  const resolution = await resolveEntriesFor(envEntryReader, localConfig);
  if (resolution.kind === 'failed') {
    log.error(describeEntryFailure(resolution.failure));
    process.exitCode = 1;
    return;
  }
  const variables = resolution.entries;
  if (variables.length === 0) {
    log.info('No env variables defined');
    return;
  }

  if (options.reveal) {
    process.stderr.write('[warn] Env values will be shown in plaintext\n');
  }

  console.log('');
  console.log(`Team env variables (${variables.length}):`);
  console.log('');
  for (const v of variables) {
    const displayValue = options.reveal ? v.entry.value : maskEnvValue(v.entry.value);
    console.log(`  ${v.name}=${displayValue}  (${describeOrigin(v)})`);
    if (v.entry.description && options.verbose) {
      log.dim(`    ${v.entry.description}`);
    }
  }
  console.log('');
}

/**
 * Add or update an env variable locally.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envAdd(
  key: string,
  value: string,
  options: GlobalOptions & { description?: string; role?: string; project?: string },
): Promise<void> {
  // env.sh is generated as `export <key>=...` and sourced by every member, so a
  // key that is not a shell identifier either breaks that line or runs as code.
  // `generateEnvFile` drops such keys, which would make this command report
  // success for a variable that never reaches anyone's shell — reject it here,
  // where the user still sees what they typed.
  if (!ENV_KEY_RE.test(key)) {
    log.error(
      `Invalid env variable name "${key}": use letters, digits and underscores, starting with a letter or underscore.`,
    );
    return;
  }

  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;

  // Pull latest
  if (!isSelfMode(localConfig)) {
    const pullSpin = spinner('Pulling latest...').start();
    try {
      await pullRepo(repoPath);
      pullSpin.succeed('Up to date');
    } catch (e) {
      pullSpin.warn(`Pull failed: ${(e as Error).message}`);
    }
  }

  const target = await envFileFromFlags(repoPath, options);
  if (!target) return;
  const { envYamlPath, where } = target;

  // Parse the target env.yaml (or create new)
  const envConfig = await envHandler.parseEnvYaml(envYamlPath);

  // Check if key already exists
  const existingIdx = envConfig.variables.findIndex(v => v.key === key);
  const isUpdate = existingIdx !== -1;

  if (isUpdate) {
    envConfig.variables[existingIdx].value = value;
    if (options.description) {
      envConfig.variables[existingIdx].description = options.description;
    }
  } else {
    const newVar: { key: string; value: string; description?: string } = { key, value };
    if (options.description) {
      newVar.description = options.description;
    }
    envConfig.variables.push(newVar);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would ${isUpdate ? 'update' : 'add'} env variable${where}: ${key}=${value}`);
    return;
  }

  // Write updated env.yaml
  await envHandler.writeEnvYaml(envYamlPath, envConfig);

  const action = isUpdate ? 'Updated' : 'Added';
  log.success(`${action} env variable${where}: ${key}=${value}`);
  log.info('Run `teamai push` to sync to team repo.');
}

/**
 * Remove an env variable locally.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envRemove(key: string, options: GlobalOptions & { role?: string; project?: string }): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;

  // Pull latest
  if (!isSelfMode(localConfig)) {
    const pullSpin = spinner('Pulling latest...').start();
    try {
      await pullRepo(repoPath);
      pullSpin.succeed('Up to date');
    } catch (e) {
      pullSpin.warn(`Pull failed: ${(e as Error).message}`);
    }
  }

  const target = await envFileFromFlags(repoPath, options);
  if (!target) return;
  const { envYamlPath, relativePath, where } = target;

  if (!await pathExists(envYamlPath)) {
    log.error(`No env variables defined (${relativePath} not found)`);
    return;
  }

  const envConfig = await envHandler.parseEnvYaml(envYamlPath);
  const idx = envConfig.variables.findIndex(v => v.key === key);

  if (idx === -1) {
    log.error(`Env variable "${key}" not found${where}`);
    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would remove env variable${where}: ${key}`);
    return;
  }

  envConfig.variables.splice(idx, 1);
  await envHandler.writeEnvYaml(envYamlPath, envConfig);

  log.success(`Removed env variable${where}: ${key}`);
  log.info('Run `teamai push` to sync to team repo.');
}

/**
 * The env file `--role <ns>` / `--project <id>` name, or env/env.yaml without
 * either. Reports the reason and returns null when the flags name none.
 */
async function envFileFromFlags(
  repoPath: string,
  flags: { role?: string; project?: string },
): Promise<{ envYamlPath: string; relativePath: string; where: string } | null> {
  const target = await entryNamespaceFromFlags(repoPath, 'env', flags);
  if (!target.ok) {
    log.error(target.message);
    process.exitCode = 1;
    return null;
  }
  const relativePath = entryFilePath('env', target.namespace);
  return {
    envYamlPath: entryFileAbsolutePath(repoPath, 'env', target.namespace),
    relativePath,
    // Messages name the file only for a namespace; the root is the default.
    where: target.namespace === null ? '' : ` in ${relativePath}`,
  };
}
