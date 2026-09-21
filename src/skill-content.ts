import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { pathExists } from './utils/fs.js';
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

/**
 * Skills the CLI serves: everything under skill-data/, or — before the content
 * moves there — everything under skills/.
 */
export async function listServableSkills(roots: PackagedSkillRoots = packagedSkillRoots()): Promise<PackagedSkill[]> {
  const served = await readSkillDirs(roots.dataRoot, false);
  if (served.length > 0) return served;
  return readSkillDirs(roots.deployRoot, true);
}

/**
 * Resolve a name or alias to a packaged skill. Servable content wins over the
 * deployed stub, which stays reachable by its exact name for debugging.
 */
export async function resolvePackagedSkill(
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

async function collectSupplementaryFiles(skillDir: string): Promise<Array<{ relativePath: string; content: string }>> {
  const files: Array<{ relativePath: string; content: string }> = [];

  for (const dirName of SUPPLEMENTARY_DIRS) {
    const root = path.join(skillDir, dirName);
    if (!(await pathExists(root))) continue;

    // Recursive: our references/ nest (references/methodology/, references/agents/),
    // so a single-level scan would silently serve an incomplete skill.
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          found.push(...(await walk(full)));
        } else if (entry.isFile()) {
          found.push(full);
        }
      }
      return found;
    };

    const absolutePaths = await walk(root);
    const relativePaths = absolutePaths
      .map((p) => path.relative(skillDir, p).split(path.sep).join('/'))
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
    targets.push(...servable);
  } else {
    for (const name of requested) {
      const skill = await resolvePackagedSkill(name, roots);
      if (!skill) {
        notFound(name, servable);
        return;
      }
      targets.push(skill);
    }
  }

  if (targets.length === 0) {
    diagnostic(`${chalk.red('✖')} No skill name provided. Usage: teamai skill get <name> [--full]`);
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

  const skill = await resolvePackagedSkill(name, roots);
  if (!skill) {
    notFound(name, await listServableSkills(roots));
    return;
  }
  console.log(skill.dir);
}

/** One catalog entry, as `teamai skill list --json` reports it. */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  path: string;
  deployed: boolean;
}

export async function skillCatalog(roots: PackagedSkillRoots = packagedSkillRoots()): Promise<SkillCatalogEntry[]> {
  const skills = await listServableSkills(roots);
  const entries: SkillCatalogEntry[] = [];
  for (const skill of skills) {
    entries.push({
      name: skill.name,
      description: await readSkillDescription(path.join(skill.dir, SKILL_MD)),
      path: skill.dir,
      deployed: skill.deployed,
    });
  }
  return entries;
}
