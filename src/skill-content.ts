import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { listFilesRecursive, pathExists } from './utils/fs.js';
import { readSkillDescription } from './agent-skills.js';

// ─── CLI-served skill content ────────────────────────────
//
//  Built-in skill bodies ship inside the npm package and are
//  printed on demand instead of being copied into every agent
//  skills directory.  What the agent reads therefore always
//  matches the installed CLI version.
//
//  npm package
//    skills/<name>/SKILL.md       deployed to agents (discovery stub)
//    skill-data/<name>/SKILL.md   never deployed, printed by `teamai skill get`
//
//  Output discipline, mirrored from agent-browser: skill content
//  goes to stdout untouched, every diagnostic goes to stderr, so a
//  piped `teamai skill get <name> > SKILL.md` stays byte-exact.
//  log.warn()/log.info() write to stdout outside hook mode, so this
//  module writes its diagnostics with console.error directly.
//

/** Placeholder replaced with the absolute skill directory when content is printed. */
export const SKILL_DIR_PLACEHOLDER = '{SKILL_DIR}';

/** Directories inside a skill whose files `--full` appends, in this order. */
const SUPPLEMENTARY_DIRS = ['references', 'templates'] as const;

const SKILL_MD = 'SKILL.md';

/**
 * Alternative names accepted by `skill get` / `skill path`.
 *
 * Legacy directory names are kept as aliases so that documentation,
 * muscle memory and older team guides keep resolving after the content
 * moves under skill-data/.
 */
const SKILL_ALIASES: Readonly<Record<string, string>> = {
  default: 'core',
  onboarding: 'setup',
  join: 'setup',
  codebase: 'wiki',
  'team-wiki-codebase': 'wiki',
  learning: 'share',
  learnings: 'share',
  'teamai-share-learnings': 'share',
};

/**
 * Served skills that need recall to be on.
 *
 * `share` publishes a session's learnings into the team's learnings branch,
 * which is meaningful only when recall is enabled. Before the discovery stub the
 * gate was in deployment — the skill was simply absent. One stub routes to every
 * workflow, so the gate moved here, where the command can also say what to turn
 * on.
 */
const RECALL_DEPENDENT_SKILLS = new Set(['share']);

/**
 * Whether recall being off makes this skill unusable right now.
 *
 * Fails open: a machine with no team config (a fresh install reading the docs)
 * gets the content rather than a refusal it cannot act on.
 */
async function blockedByRecall(name: string): Promise<boolean> {
  if (!RECALL_DEPENDENT_SKILLS.has(name)) return false;
  try {
    const [{ autoDetectInit }, { isRecallEnabled }] = await Promise.all([
      import('./config.js'),
      import('./types.js'),
    ]);
    const { localConfig, teamConfig } = await autoDetectInit();
    return !isRecallEnabled(localConfig, teamConfig);
  } catch {
    return false;
  }
}

/** A skill directory that ships inside the npm package. */
export interface PackagedSkill {
  name: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** True when this copy is the unit deployed into agent skills directories. */
  deployed: boolean;
}

/** The two packaged roots: deployable units and CLI-served content. */
export interface PackagedSkillRoots {
  /** `skills/` — what `deployBuiltinSkills` copies into agents. */
  deployRoot: string;
  /** `skill-data/` — never deployed, printed on demand. */
  dataRoot: string;
}

/**
 * Locate the packaged roots relative to this module.
 *
 * `realpathSync` first: a global `npm i -g` install exposes the CLI through a
 * symlinked bin, and without resolving it `..` can land outside the package.
 */
export function packagedSkillRoots(): PackagedSkillRoots {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;
  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }
  const packageRoot = path.join(moduleDir, '..');
  return {
    deployRoot: path.join(packageRoot, 'skills'),
    dataRoot: path.join(packageRoot, 'skill-data'),
  };
}

async function readSkillDirs(root: string, deployed: boolean): Promise<PackagedSkill[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return [];
  }

  const skills: PackagedSkill[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue;
    const dir = path.join(root, entry);
    if (await pathExists(path.join(dir, SKILL_MD))) {
      skills.push({ name: entry, dir, deployed });
    }
  }
  return skills;
}

/** Skills the CLI serves on demand: everything under skill-data/. */
export async function listServableSkills(roots: PackagedSkillRoots = packagedSkillRoots()): Promise<PackagedSkill[]> {
  return readSkillDirs(roots.dataRoot, false);
}

/**
 * Resolve a name or alias to a packaged skill. Servable content wins over the
 * deployed stub, which stays reachable by its exact name for debugging.
 */
async function resolvePackagedSkill(
  name: string,
  roots: PackagedSkillRoots = packagedSkillRoots(),
): Promise<PackagedSkill | null> {
  const servable = await listServableSkills(roots);
  const deployed = await readSkillDirs(roots.deployRoot, true);
  const candidates = [...servable, ...deployed.filter((s) => !servable.some((v) => v.name === s.name))];

  const direct = candidates.find((s) => s.name === name);
  if (direct) return direct;

  const aliased = SKILL_ALIASES[name];
  if (aliased) {
    const match = candidates.find((s) => s.name === aliased);
    if (match) return match;
  }
  return null;
}

/**
 * The outcome of asking for a skill by name. `blocked` carries the same
 * information as `found`, minus the skill: a caller cannot print a directory it
 * never received.
 */
export type ServableSkillResolution =
  | { kind: 'found'; skill: PackagedSkill }
  | { kind: 'blocked'; name: string; reason: 'recall' }
  | { kind: 'not-found'; name: string };

/**
 * The only way to obtain a packaged skill outside this module.
 *
 * The recall gate is applied here, once, so every command that hands out a
 * skill's content or its directory (`get`, `path`, `list`, `show`) inherits it
 * by construction instead of remembering to check.
 */
export async function resolveServableSkill(
  name: string,
  roots: PackagedSkillRoots = packagedSkillRoots(),
): Promise<ServableSkillResolution> {
  const skill = await resolvePackagedSkill(name, roots);
  if (!skill) return { kind: 'not-found', name };
  if (await blockedByRecall(skill.name)) return { kind: 'blocked', name: skill.name, reason: 'recall' };
  return { kind: 'found', skill };
}

/** The two lines every command prints for a recall-blocked skill. */
export function recallBlockMessage(name: string): { headline: string; hint: string } {
  return {
    headline: `${name} needs recall, which is disabled for this team.`,
    hint: 'Turn it on with `teamai recall enable`, or ask your team admin to enable sharing.',
  };
}

async function collectSupplementaryFiles(skillDir: string): Promise<Array<{ relativePath: string; content: string }>> {
  const files: Array<{ relativePath: string; content: string }> = [];

  for (const dirName of SUPPLEMENTARY_DIRS) {
    // listFilesRecursive walks nested directories and skips .pyc, __pycache__ and
    // the rest of the repo's ignore list, which matters for the wiki's scripts/.
    // Our references nest (references/methodology/, references/phases/), so a
    // single-level scan would serve an incomplete skill.
    const relativePaths = (await listFilesRecursive(path.join(skillDir, dirName)))
      .map((relative) => `${dirName}/${relative}`)
      .sort();

    for (const relativePath of relativePaths) {
      files.push({
        relativePath,
        content: await fs.promises.readFile(path.join(skillDir, relativePath), 'utf8'),
      });
    }
  }

  return files;
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Render a packaged skill exactly as the agent should read it: the raw
 * SKILL.md including frontmatter, with {SKILL_DIR} resolved to the absolute
 * packaged directory so that documented script invocations can be run as-is.
 */
export async function renderSkill(skill: PackagedSkill, options: { full?: boolean } = {}): Promise<string> {
  const resolve = (text: string): string => text.split(SKILL_DIR_PLACEHOLDER).join(skill.dir);

  let out = withTrailingNewline(resolve(await fs.promises.readFile(path.join(skill.dir, SKILL_MD), 'utf8')));

  if (options.full) {
    for (const file of await collectSupplementaryFiles(skill.dir)) {
      out += `\n--- ${file.relativePath} ---\n\n`;
      out += withTrailingNewline(resolve(file.content));
    }
  }

  return out;
}

/** Diagnostics never share stdout with skill content. */
function diagnostic(line: string): void {
  console.error(line);
}

function notFound(name: string, available: PackagedSkill[]): void {
  diagnostic(`${chalk.red('✖')} Skill not found: ${name}`);
  diagnostic(`  Available: ${available.map((s) => s.name).join(', ')}`);
  diagnostic('  Run `teamai skill list` to see what the installed CLI serves.');
  process.exitCode = 1;
}

function rootsMissing(): void {
  diagnostic(`${chalk.red('✖')} Packaged skill content not found.`);
  diagnostic('  The installed teamai-cli package looks incomplete; reinstall with `npm i -g teamai-cli`.');
  process.exitCode = 1;
}

/**
 * Refuse a skill the recall gate blocks. Every path that hands out a skill's
 * content or its directory goes through here, so the gate that replaced the
 * old deployment restriction cannot be sidestepped by asking differently.
 */
function refuseBlockedByRecall(name: string): void {
  const { headline, hint } = recallBlockMessage(name);
  diagnostic(`${chalk.red('✖')} ${headline}`);
  diagnostic(`  ${hint}`);
  process.exitCode = 1;
}

export interface SkillGetOptions {
  full?: boolean;
  all?: boolean;
}

/**
 * `teamai skill get <name...> [--full] [--all]` — print version-matched skill
 * content to stdout.
 */
export async function skillGet(names: string[], options: SkillGetOptions = {}): Promise<void> {
  const roots = packagedSkillRoots();
  const servable = await listServableSkills(roots);

  if (servable.length === 0) {
    rootsMissing();
    return;
  }

  // An unknown flag is forgiven — a hallucinated flag should not cost the agent a
  // round-trip — but an unknown name is fatal: the agent would act on the wrong
  // instructions. Commander hands unknown options through as operands here.
  const requested: string[] = [];
  for (const name of names) {
    if (name.startsWith('-')) {
      diagnostic(`${chalk.yellow('⚠')} Unknown flag ignored: ${name}`);
      continue;
    }
    requested.push(name);
  }

  const targets: PackagedSkill[] = [];
  if (options.all) {
    // The gate holds for the inventory dump too: a blocked skill is left out
    // and named on stderr, the rest is still served.
    for (const listed of servable) {
      const resolved = await resolveServableSkill(listed.name, roots);
      if (resolved.kind !== 'found') {
        diagnostic(`${chalk.yellow('⚠')} Skipped ${listed.name}: needs recall, which is disabled for this team (teamai recall enable).`);
        continue;
      }
      targets.push(resolved.skill);
    }
  } else {
    for (const name of requested) {
      const resolved = await resolveServableSkill(name, roots);
      if (resolved.kind === 'not-found') {
        notFound(name, servable);
        return;
      }
      if (resolved.kind === 'blocked') {
        refuseBlockedByRecall(resolved.name);
        return;
      }
      targets.push(resolved.skill);
    }
  }

  if (targets.length === 0) {
    diagnostic(`${chalk.red('✖')} No skill name provided. Usage: teamai skill get <name> [--full], or --all`);
    diagnostic(`  Available: ${servable.map((s) => s.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const rendered: string[] = [];
  for (const skill of targets) {
    rendered.push(await renderSkill(skill, { full: options.full }));
  }
  process.stdout.write(rendered.join('\n---\n\n'));
}

/**
 * `teamai skill path [name]` — print the packaged directory, for agents that
 * read files directly or need to run the scripts a skill ships.
 */
export async function skillPath(name?: string): Promise<void> {
  const roots = packagedSkillRoots();

  if (!name) {
    let printed = false;
    for (const root of [roots.deployRoot, roots.dataRoot]) {
      if (await pathExists(root)) {
        console.log(root);
        printed = true;
      }
    }
    if (!printed) rootsMissing();
    return;
  }

  const resolved = await resolveServableSkill(name, roots);
  switch (resolved.kind) {
    case 'not-found':
      notFound(name, await listServableSkills(roots));
      return;
    case 'blocked':
      refuseBlockedByRecall(resolved.name);
      return;
    case 'found':
      console.log(resolved.skill.dir);
      return;
    default: {
      const exhaustive: never = resolved;
      throw new Error(`Unhandled resolution ${String(exhaustive)}`);
    }
  }
}

/**
 * One catalog entry, as `teamai skill list --json` reports it.
 *
 * A skill the recall gate blocks is still listed, so the agent learns it exists
 * and what to turn on, but its directory is withheld like `skill path` does.
 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  path: string | null;
  deployed: boolean;
  blockedByRecall: boolean;
}

export async function skillCatalog(roots: PackagedSkillRoots = packagedSkillRoots()): Promise<SkillCatalogEntry[]> {
  const skills = await listServableSkills(roots);
  const entries: SkillCatalogEntry[] = [];
  for (const skill of skills) {
    const blocked = (await resolveServableSkill(skill.name, roots)).kind === 'blocked';
    entries.push({
      name: skill.name,
      description: await readSkillDescription(path.join(skill.dir, SKILL_MD)),
      path: blocked ? null : skill.dir,
      deployed: skill.deployed,
      blockedByRecall: blocked,
    });
  }
  return entries;
}
