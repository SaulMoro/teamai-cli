import path from 'node:path';
import fs from 'node:fs';
import { expandHome, listFilesRecursive, pathExists, readFileSafe } from './utils/fs.js';
import { getDataHome, getMcpSharing, TEAMAI_ENV_START, TEAMAI_ENV_END } from './types.js';
import type { ResourceItem } from './types.js';
import { usesCursorMdcRules, usesCopilotInstructions } from './resources/rule-format.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import type { ResourceHandler } from './resources/base.js';
import type { Check, DoctorContext } from './doctor.js';

/**
 * The checks that verify the payload rather than the plumbing: what each tool
 * was owed, against what is on its disk (#598, #624).
 *
 * They live beside `doctor.ts` rather than inside it because every one of them
 * is domain logic — where a rule lands for Cursor, which tools an agent's spec
 * targets, whether a shell block would load — and `doctor.ts` is the registry
 * that runs them.
 *
 * Every check here is read-only by contract. `doctor-delivery.test.ts` asserts
 * it directly: resolving a destination must never write, or the command whose
 * job is to describe the machine would change it.
 */

/**
 * Whether a delivered skill directory is one an agent can actually discover:
 * SKILL.md present, frontmatter parses, and its `name` is the directory's own.
 * A copy that fails this landed successfully — no write-time gate can see it.
 */
async function skillIsDiscoverable(skillDir: string, skillName: string): Promise<boolean> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  if (!content) return false;

  const { data, valid } = splitFrontmatter(content);
  if (!valid) return false;
  return data.name === skillName;
}

/**
 * Whether `filePath` is a file something can actually read. `pathExists`
 * follows symlinks but says yes to a directory too, so on its own it cannot
 * tell a delivered document from a name occupied by something else.
 */
async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(expandHome(filePath))).isFile();
  } catch {
    return false;
  }
}

/** At most this many names in a fix string; the rest are counted. */
const MAX_NAMED_IN_FIX = 5;

/** Group item names under the tool that did not receive them. */
function appendTo(buckets: Map<string, string[]>, tool: string, name: string): void {
  const names = buckets.get(tool);
  if (names) names.push(name);
  else buckets.set(tool, [name]);
}

/** What one tool was owed, and which of it did not arrive intact. */
interface ToolDelivery {
  /** Where its items land — the fix names it when the filename is derived. */
  dir: string;
  /** Item names grouped by the problem label `classify` gave them. */
  problems: Map<string, string[]>;
}

/**
 * Walk every desired item across the tools that receive it, letting `classify`
 * name what is wrong with each delivered path, or return null when it arrived
 * intact. A tool absent from every item's targets receives nothing, so nothing
 * is owed: it is either uninstalled — caught by its own `<tool> is installed`
 * check — or configured without a path for this resource.
 */
async function walkDelivery(
  handler: ResourceHandler,
  ctx: DoctorContext,
  items: ResourceItem[],
  classify: (tool: string, dest: string, item: ResourceItem) => Promise<string | null>,
): Promise<{ byTool: Map<string, ToolDelivery>; unreceived: string[] }> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return { byTool: new Map(), unreceived: [] };

  const byTool = new Map<string, ToolDelivery>();
  const unreceived: string[] = [];

  for (const item of items) {
    const targets = await handler.deliveryTargets(teamConfig, localConfig, item);
    if (targets.length === 0) unreceived.push(item.name);

    for (const { tool, dest } of targets) {
      let delivery = byTool.get(tool);
      if (!delivery) {
        delivery = { dir: path.dirname(dest), problems: new Map() };
        byTool.set(tool, delivery);
      }
      const problem = await classify(tool, dest, item);
      if (problem !== null) appendTo(delivery.problems, problem, item.name);
    }
  }

  return { byTool, unreceived };
}

/**
 * `not delivered: a, b; unreadable: c`, with the labels in the order the caller
 * lists them rather than the order the failures happened, so the same broken
 * machine reads the same way twice.
 */
function describeProblems(problems: Map<string, string[]>, labels: readonly string[]): string {
  return labels
    .filter((label) => (problems.get(label)?.length ?? 0) > 0)
    .map((label) => `${label}: ${nameList(problems.get(label) ?? [])}`)
    .join('; ');
}

/** `a, b, c and 4 more` — a fix a human reads, not a wall of paths. */
function nameList(names: string[]): string {
  if (names.length <= MAX_NAMED_IN_FIX) return names.join(', ');
  const shown = names.slice(0, MAX_NAMED_IN_FIX).join(', ');
  return `${shown} and ${names.length - MAX_NAMED_IN_FIX} more`;
}

/**
 * Build one delivery check per installed tool: every skill the member should
 * have, against what is actually on disk for that tool.
 *
 * This is the only check that looks at the payload rather than the plumbing. A
 * write-time gate cannot cover it — `SkillsHandler.pullItem` skips each
 * uninstalled tool on its own, and a directory deleted by hand after a correct
 * pull leaves every gate happy (#598).
 *
 * The scan runs here rather than inside `check()` because the fix names the
 * skills that are missing, and a `Check`'s fix is read as it was built.
 */
export async function buildDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  // Dynamic: pull.ts imports this module for its post-pull pass, and the desired
  // set is policy that must not be restated here.
  const { buildRolePullContext, resolveDesiredSkills } = await import('./pull.js');
  const { getHandler } = await import('./resources/index.js');

  let items: ResourceItem[];
  try {
    const roleContext = await buildRolePullContext(localConfig);
    ({ items } = await resolveDesiredSkills(teamConfig, localConfig, roleContext));
  } catch (e) {
    // A team repo whose active namespaces collide cannot say what should be
    // delivered — `pull` aborts the scope with this same message. The command
    // whose job is explaining bad state must report it, not stack-trace on it.
    return [{
      name: 'Skills to deliver can be resolved',
      source: 'local',
      check: async () => false,
      fix: `${(e as Error).message}. Until the team repo is fixed, `
        + 'pull cannot sync skills for this role.',
    }];
  }
  if (items.length === 0) return [];

  const labels = ['not delivered', 'delivered but unreadable'] as const;
  const { byTool } = await walkDelivery(getHandler('skills'), ctx, items, async (_tool, dest, item) => {
    if (!await pathExists(dest)) return labels[0];
    return await skillIsDiscoverable(dest, item.name) ? null : labels[1];
  });

  return [...byTool].map(([tool, delivery]) => ({
    name: `Skills delivered to ${tool}`,
    source: 'local',
    check: async () => delivery.problems.size === 0,
    fix: `In ${tool}, ${describeProblems(delivery.problems, labels)}. Run \`teamai pull --force\`: `
      + 'a plain pull skips a scope whose team repo has not changed, so it cannot restore this. '
      + 'If a skill stays unreadable, fix its SKILL.md in the team repo — the '
      + 'frontmatter needs a `name` matching the directory, or the agent never '
      + 'discovers it.',
  }));
}

/**
 * Whether a delivered rule is one its tool can actually apply. Cursor-compatible
 * tools and Copilot read machine-derived frontmatter — `globs`/`alwaysApply` and
 * `applyTo` — so a copy that landed without it is inert, the same class of
 * failure as a skill whose SKILL.md an agent cannot discover. A plain `.md` copy
 * carries no such contract and only has to be readable.
 */
async function ruleIsApplicable(tool: string, dest: string): Promise<boolean> {
  const content = await readFileSafe(dest);
  if (content === null) return false;

  if (usesCursorMdcRules(tool)) {
    const { data, valid } = splitFrontmatter(content);
    return valid && data.alwaysApply !== undefined;
  }
  if (usesCopilotInstructions(tool)) {
    const { data, valid } = splitFrontmatter(content);
    return valid && typeof data.applyTo === 'string' && data.applyTo.length > 0;
  }
  return true;
}

/**
 * Build one delivery check per tool that receives rules: every rule the member
 * should have, against what is on disk for that tool.
 *
 * Rules change filename *and* content per tool, so only the handler can say
 * where one lands. Asking it here is what keeps the check from growing its own
 * copy of the extension table (#624).
 */
export async function buildRulesDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { buildRolePullContext, resolveDesiredRules } = await import('./pull.js');
  const { getHandler } = await import('./resources/index.js');

  const roleContext = await buildRolePullContext(localConfig);
  const { items } = await resolveDesiredRules(teamConfig, localConfig, roleContext);
  if (items.length === 0) return [];

  return [...(await walkDelivery(
    getHandler('rules'),
    ctx,
    items,
    async (tool, dest) => {
      if (!await isReadableFile(dest)) return 'not delivered';
      return await ruleIsApplicable(tool, dest)
        ? null
        : `delivered without the frontmatter ${tool} reads`;
    },
  )).byTool].map(([tool, delivery]) => ({
    name: `Rules delivered to ${tool}`,
    source: 'local',
    check: async () => delivery.problems.size === 0,
    // The fix names the directory rather than the tool: a rule's delivered
    // filename carries a per-tool extension the reader would have to derive.
    fix: `In ${delivery.dir}, `
      + `${describeProblems(delivery.problems, ['not delivered', `delivered without the frontmatter ${tool} reads`])}. `
      + 'Run `teamai pull --force`: a plain pull skips a scope whose team repo has not changed, '
      + 'so it cannot restore this.',
  }));
}

/**
 * Build one delivery check per tool that receives agents.
 *
 * An agent's desired set is a relation rather than a product: `spec.targets`
 * names the tools it is for, and each renders into its own format, so the
 * handler is the only thing that can say which tools owe what file (#624).
 */
export async function buildAgentsDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { buildRolePullContext, resolveDesiredAgents } = await import('./pull.js');
  const { getHandler } = await import('./resources/index.js');

  let items: ResourceItem[];
  try {
    const roleContext = await buildRolePullContext(localConfig);
    items = await resolveDesiredAgents(teamConfig, localConfig, roleContext);
  } catch (e) {
    // Two active namespaces claiming one agent name: `pull` aborts the scope
    // with this message rather than picking one, so `doctor` reports it.
    return [{
      name: 'Agents to deliver can be resolved',
      source: 'local',
      check: async () => false,
      fix: `${(e as Error).message}. Until the team repo is fixed, `
        + 'pull cannot sync agents for this role.',
    }];
  }
  if (items.length === 0) return [];

  // An agent whose spec reaches no tool at all is not a per-tool failure: the
  // file is in the team repo and nothing renders it anywhere.
  const { byTool, unreceived: unreachable } = await walkDelivery(
    getHandler('agents'),
    ctx,
    items,
    async (_tool, dest) => await isReadableFile(dest) ? null : 'not delivered',
  );

  const checks: Check[] = [...byTool].map(([tool, delivery]) => ({
    name: `Agents delivered to ${tool}`,
    source: 'local',
    check: async () => delivery.problems.size === 0,
    fix: `In ${delivery.dir}, ${describeProblems(delivery.problems, ['not delivered'])}. `
      + 'Run `teamai pull --force`: a plain pull skips a scope whose team repo has not changed, '
      + 'so it cannot restore this.',
  }));

  // Only worth reporting once some tool does receive agents: with none
  // installed, "reaches no tool" is the machine, not the team repo.
  if (unreachable.length > 0 && byTool.size > 0) {
    checks.push({
      name: 'Every team agent reaches a tool',
      source: 'local',
      check: async () => false,
      fix: `${nameList(unreachable)} render for no installed tool. Either the spec does not `
        + 'parse — `teamai pull` names the reason — or its `targets:` lists only tools that '
        + 'are not installed here.',
    });
  }

  return checks;
}

/**
 * Build one check per tool that receives MCP servers.
 *
 * An MCP server is an entry inside the tool's own config file, not a file of
 * its own, so this takes the shape of the hook check rather than of
 * `deliveryTargets`. It reports two things a pull says once and never again:
 * a desired server whose entry is not there, and a server the reconcile
 * skipped — an unresolved `${VAR}` is the reason behind "MCP does not work"
 * that no other output points at (#662).
 */
export async function buildMcpDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  // HTTP-backed teams have no repo tree: servers arrive through the local-agent
  // install channel, and the desired set here would always be empty.
  if (localConfig.repo.kind === 'http') return [];

  const sharing = getMcpSharing(teamConfig);
  // Nothing was promised automatically, so nothing is owed until the member
  // runs `teamai mcp inject`.
  if (!sharing.autoApply) return [];

  const {
    resolveMcpTargets, buildDesiredMcpContext, desiredMcpForTarget,
    mcpTargetExcluded, installedMcpServerNames,
  } = await import('./mcp-reconcile.js');
  const { parseTeamMcpServers } = await import('./resources/mcp.js');

  const teamDefs = await parseTeamMcpServers(localConfig.repo.localPath);
  if (teamDefs.length === 0) return [];

  const targets = await resolveMcpTargets(teamConfig, localConfig);
  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig);
  const excludedByUser = new Set(localConfig.excludedSkills ?? []);

  const checks: Check[] = [];
  for (const target of targets) {
    if (mcpTargetExcluded(localConfig, target)) continue;

    const { desired, skipped } = desiredMcpForTarget(target, teamDefs, desiredContext);
    const blocked = skipped
      .filter((change) => !excludedByUser.has(change.server))
      .map((change) => `${change.server} (${change.reason ?? 'skipped'})`);

    const problems: string[] = [];
    const installed = await installedMcpServerNames(target);
    if (installed === null) {
      problems.push(`${target.file} could not be parsed, so no server was injected`);
    } else if (desired.size > 0) {
      const absent = [...desired.keys()].filter((name) => !installed.includes(name));
      if (absent.length > 0) problems.push(`not injected: ${nameList(absent)}`);
    }
    if (blocked.length > 0) problems.push(`skipped: ${nameList(blocked)}`);

    if (problems.length === 0 && desired.size === 0) continue;

    checks.push({
      name: `MCP servers delivered to ${target.tool}`,
      source: 'local',
      check: async () => problems.length === 0,
      fix: `In ${target.file}, ${problems.join('; ')}. A server needing a variable reads it from `
        + '`env/env.yaml`, whose top-level key is `variables:` — a plain `KEY: value` mapping '
        + 'parses as no variables at all. Then run `teamai pull --force`.',
    });
  }

  return checks;
}

/** The TeamAI-managed block of a shell profile, or null when it is absent. */
function envBlockIn(profileContent: string): string | null {
  const start = profileContent.indexOf(TEAMAI_ENV_START);
  if (start === -1) return null;
  const end = profileContent.indexOf(TEAMAI_ENV_END, start);
  return end === -1 ? profileContent.slice(start) : profileContent.slice(start, end);
}

/**
 * Whether the injected block would actually load `env.sh` when a POSIX shell
 * reads it.
 *
 * The block is generated by joining paths with the platform separator, so on
 * Windows it carries backslashes. An unquoted `\` is an escape character there,
 * so `[ -f C:\Users\me\.teamai/env.sh ]` tests a path that cannot exist, `&&`
 * short-circuits and `source` never runs — silently, because a failed `[` test
 * in a profile prints nothing (#661). A path containing whitespace needs quotes
 * for the same reason.
 */
function envBlockLoads(block: string, envShPath: string): boolean {
  const posixPath = envShPath.split(path.sep).join('/');
  if (!block.includes(posixPath)) return false;
  if (!/\s/.test(posixPath)) return true;
  return block.includes(`"${posixPath}"`) || block.includes(`'${posixPath}'`);
}

/**
 * Check that the env variables the team declares actually reach a shell.
 *
 * The plumbing version of this check asked only whether the marker comment was
 * in the profile, which is true of a block that cannot load and of a run that
 * delivered nothing. Both failures surface three layers away, as MCP servers
 * skipped for `unresolved variable(s)`, with nothing pointing back here.
 */
export async function buildEnvDeliveryCheck(ctx: DoctorContext): Promise<Check[]> {
  const problems = await envDeliveryProblems(ctx);
  return [{
    name: 'Env variables injected in shell profile',
    source: 'local',
    check: async () => problems.length === 0,
    fix: problems.length === 0
      ? 'Run `teamai pull` to inject env variables into shell profile'
      : `${problems.join('; ')}. Run \`teamai pull\` after fixing the cause, then open a new shell.`,
  }];
}

/** Every reason the team's env variables are not reaching a shell. */
async function envDeliveryProblems(ctx: DoctorContext): Promise<string[]> {
  const { localConfig, teamConfig } = ctx;
  if (teamConfig?.sharing?.env?.injectShellProfile === false) return [];

  const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
  if (!await pathExists(envYamlPath)) return [];

  const { EnvHandler } = await import('./resources/env.js');
  const envHandler = new EnvHandler();
  const declared = (await envHandler.parseEnvYaml(envYamlPath)).variables;

  const problems: string[] = [];

  // A file with content that yields no variables is the shorthand `KEY: value`
  // form: zod drops the unknown top-level key and defaults `variables` to [],
  // so the pull writes nothing and says nothing (#662).
  const raw = await readFileSafe(envYamlPath);
  if (declared.length === 0) {
    if (raw !== null && raw.trim() !== '') {
      problems.push(
        `${envYamlPath} declares no variables. Its top-level key must be \`variables:\`, a list of `
        + '`key`/`value` entries — a plain `KEY: value` mapping parses as an empty list',
      );
    }
    // Nothing declared and nothing malformed: there is nothing to deliver.
    return problems;
  }

  // env.sh lives under teamaiHome, which is <projectRoot>/.teamai in project
  // scope and ~/.teamai in user scope — mirror the path that `teamai pull`
  // actually writes to, not a hardcoded user-home path.
  const envShPath = path.join(getDataHome(localConfig), 'env.sh');
  const envSh = await readFileSafe(envShPath);
  if (envSh === null) {
    problems.push(`${envShPath} is missing`);
  } else {
    const undelivered = declared.filter((v) => !envSh.includes(`export ${v.key}=`));
    if (undelivered.length > 0) {
      problems.push(`${envShPath} is missing ${nameList(undelivered.map((v) => v.key))}`);
    }
  }

  // Same resolution the injection runs, not a second copy of it.
  const profilePath = teamConfig?.sharing?.env?.shellProfilePath ?? envHandler.detectShellProfile();
  const profile = await readFileSafe(profilePath);
  const block = profile === null ? null : envBlockIn(profile);

  if (block === null) {
    problems.push(`${profilePath} carries no TeamAI env block`);
  } else if (envSh !== null && !envBlockLoads(block, envShPath)) {
    problems.push(
      `the block in ${profilePath} does not load ${envShPath}: a POSIX shell reads an unquoted `
      + 'backslash as an escape, so the `[ -f ... ]` test fails and `source` never runs',
    );
  }

  return problems;
}

/**
 * The docs bundle has one destination rather than one per tool: `DocsHandler`
 * copies the whole `docs/` tree into `sharing.docs.localDir`. So this check
 * compares the two trees, file by file, rather than asking each tool.
 */
export async function buildDocsCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { DocsHandler, resolveDocsDestination } = await import('./resources/docs.js');
  const handler = new DocsHandler();
  const [item] = await handler.scanTeamForPull(teamConfig, localConfig);
  if (!item) return [];

  const dest = resolveDocsDestination(teamConfig, localConfig);
  const teamFiles = (await listFilesRecursive(item.sourcePath))
    // Same filter DocsHandler.pullItem copies with: dotfiles never travel.
    .filter((file) => file.split('/').every((segment) => !segment.startsWith('.')));

  // isFile, not merely "something is there": a directory sitting on the
  // expected name, or a symlink with nothing behind it, would satisfy a plain
  // existence check while the doc is no more readable than a missing one.
  const missing: string[] = [];
  for (const file of teamFiles) {
    if (!await isReadableFile(path.join(dest, file))) missing.push(file);
  }

  return [{
    name: 'Team docs delivered',
    source: 'local',
    check: async () => missing.length === 0,
    fix: `Missing from ${dest}: ${nameList(missing)}. Run \`teamai pull --force\`: a plain `
      + 'pull skips a scope whose team repo has not changed, so it cannot restore these.',
  }];
}
