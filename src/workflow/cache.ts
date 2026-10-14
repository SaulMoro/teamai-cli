import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../utils/logger.js';
import { pathExists, readFileSafe, remove, writeJsonAtomic } from '../utils/fs.js';
import {
  getBusinessRoot,
  getDataHome,
  getKnowledgeDir,
  isSelfMode,
  managedMcpWorkspaceId,
  type LocalConfig,
} from '../types.js';
import { formatDiagnostic, parseWorkflow, promptFileDiagnostics, stepField, type WorkflowFiles } from './parse.js';
import type { CachedWorkflow, WorkflowDefinition, WorkflowDiagnostic, WorkflowStep } from './types.js';
import { assertSafePath, assertWithinRoot } from '../utils/path-safety.js';

export interface SyncWorkflowOptions {
  dryRun?: boolean;
  scopeLabel?: string;
}

export interface SyncWorkflowResult {
  cached: string[];
  kept: string[];
  invalid: WorkflowDiagnostic[];
  unrunnable: string[];
}

/** One version of a file, as its reference checks read it: this revision, or the copy the cache keeps. */
interface Version {
  relativePath: string;
  content: string;
  definition: WorkflowDefinition;
  promptFileLocations: Record<string, { line: number; column: number }>;
}

/** A file that passed its own checks, before the workflows it runs are checked. */
interface Candidate extends Version {
  stem: string;
  sourceHash: string;
}

/** What a file runs after this sync, and why the versions it did not pick cannot run. */
interface Settled {
  /** This revision, else the kept copy, or null when neither can run. */
  definition: WorkflowDefinition | null;
  /** The reference problems of this revision. Empty when it has none or failed its own checks. */
  revision: WorkflowDiagnostic[];
  /** Why the kept copy cannot run either. Empty when it runs or was never checked. */
  kept: WorkflowDiagnostic[];
}

type Checked = Candidate | { stem: string; relativePath: string; diagnostics: WorkflowDiagnostic[] };

function cacheDir(config: LocalConfig): string {
  const home = getDataHome(config);
  // Self mode shares one data home across checkouts, and each checkout has its own workflows/.
  if (isSelfMode(config)) {
    return path.join(home, 'workspaces', managedMcpWorkspaceId(getBusinessRoot(config)), 'workflows', 'cache');
  }
  return path.join(home, 'workflows', 'cache');
}

function cachePath(config: LocalConfig, name: string): string {
  return path.join(cacheDir(config), `${name}.json`);
}

async function readCache(config: LocalConfig, name: string): Promise<CachedWorkflow | null> {
  const raw = await readFileSafe(cachePath(config, name));
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const cached = value as CachedWorkflow;
    if (cached.definition?.schemaVersion !== 'v1alpha1' || cached.definition.name !== name) return null;
    return cached;
  } catch {
    return null;
  }
}

/** The last validated definition for `name`, or null when this file has never been valid. */
export async function loadCachedWorkflow(config: LocalConfig, name: string): Promise<CachedWorkflow | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return readCache(config, name);
}

async function dropCachesForMissingFiles(config: LocalConfig): Promise<void> {
  const dir = cacheDir(config);
  if (!await pathExists(dir)) return;
  const knowledge = path.resolve(getKnowledgeDir(config));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const cached = await readCache(config, name.replace(/\.json$/, ''));
    if (!cached) continue;
    const source = path.resolve(knowledge, cached.relativePath);
    const inside = source === knowledge || source.startsWith(`${knowledge}${path.sep}`);
    if (!inside || !await pathExists(source)) await remove(cachePath(config, cached.definition.name));
  }
}

/**
 * Validate each `workflows/*.yaml` on its own and cache only files that pass.
 * An invalid file keeps its last cached definition; a file that was never valid
 * stays unrunnable. Nothing here fails the caller.
 */
export async function syncWorkflowDefinitions(
  config: LocalConfig,
  options: SyncWorkflowOptions = {},
): Promise<SyncWorkflowResult> {
  const result: SyncWorkflowResult = { cached: [], kept: [], invalid: [], unrunnable: [] };
  const dir = path.join(getKnowledgeDir(config), 'workflows');
  if (!options.dryRun) await dropCachesForMissingFiles(config);
  let dirStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    dirStat = await fs.lstat(dir);
  } catch {
    return result;
  }
  // readdir follows a directory symlink, so reject the directory itself before listing it.
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return result;

  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.yaml')).sort();
  } catch {
    return result;
  }

  const checked: Checked[] = [];
  for (const name of names) {
    const relativePath = `workflows/${name}`;
    const full = path.join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(full);
    } catch {
      continue;
    }
    // A symlink is not a workflow file, even when the target is a YAML file outside this directory.
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const content = await readFileSafe(full);
    if (content === null) {
      const diagnostic: WorkflowDiagnostic = {
        file: relativePath,
        line: 1,
        column: 1,
        field: '(root)',
        message: 'workflow file could not be read',
      };
      result.invalid.push(diagnostic);
      log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
      continue;
    }
    const stem = name.replace(/\.yaml$/, '');
    const parsed = parseWorkflow(relativePath, content);
    if (!parsed.ok) {
      checked.push({ stem, relativePath, diagnostics: parsed.diagnostics });
      continue;
    }
    const resolved = await resolvePromptFiles(config, parsed.definition, parsed.promptFileLocations, relativePath);
    if (!resolved.ok) {
      checked.push({ stem, relativePath, diagnostics: resolved.diagnostics });
      continue;
    }
    const hash = createHash('sha256').update(content);
    for (const source of resolved.sources) {
      hash.update('\0').update(source.path).update('\0').update(source.content);
    }
    checked.push({
      stem, relativePath, content, definition: resolved.definition, sourceHash: hash.digest('hex'), promptFileLocations: parsed.promptFileLocations,
    });
  }

  const kept = new Map<string, CachedWorkflow | null>();
  for (const file of checked) {
    const dropped = 'diagnostics' in file && dropsKeptVersion(file.diagnostics);
    kept.set(file.stem, dropped ? null : await readCache(config, file.stem));
  }
  const settle = checkReferences(checked, kept);

  const reject = async ({ stem, relativePath }: Checked, diagnostics: WorkflowDiagnostic[]): Promise<void> => {
    result.invalid.push(...diagnostics);
    for (const diagnostic of diagnostics) log.warn(`[workflows] ${formatDiagnostic(diagnostic)}`);
    const settled = settle(stem);
    // The kept copy's line numbers point into a revision the file no longer has, so only the message is shown.
    for (const problem of settled.kept) log.warn(`[workflows] Dropped the last valid version of ${stem}: ${problem.message}`);
    if (settled.definition) {
      result.kept.push(stem);
      log.warn(`[workflows] Kept the last valid version of ${stem}; this revision was not cached`);
    } else {
      if (!options.dryRun) await remove(cachePath(config, stem));
      result.unrunnable.push(relativePath);
      log.warn(`[workflows] ${relativePath} has no runnable version`);
    }
  };
  let wrote = 0;
  for (const file of checked) {
    if ('diagnostics' in file) {
      await reject(file, file.diagnostics);
      continue;
    }
    const problems = settle(file.stem).revision;
    if (problems.length > 0) {
      await reject(file, problems);
      continue;
    }
    const previous = await readCache(config, file.definition.name);
    result.cached.push(file.definition.name);
    if (options.dryRun || previous?.sourceHash === file.sourceHash) continue;
    await writeJsonAtomic(cachePath(config, file.definition.name), {
      relativePath: file.relativePath,
      sourceHash: file.sourceHash,
      content: file.content,
      definition: file.definition,
      validatedAt: new Date().toISOString(),
    } satisfies CachedWorkflow);
    wrote += 1;
  }

  const scope = options.scopeLabel ?? config.scope;
  if (options.dryRun && result.cached.length > 0) {
    log.info(`[${scope}] [dry-run] Would cache ${result.cached.length} workflow${result.cached.length === 1 ? '' : 's'}`);
  } else if (wrote > 0) {
    log.success(`[${scope}] Synced ${wrote} workflow${wrote === 1 ? '' : 's'}`);
  }
  return result;
}

/**
 * An invalid revision keeps the last valid version, unless a diagnostic has a code:
 * a code changes what the file means, so the previous definition must not keep running.
 */
function dropsKeptVersion(diagnostics: WorkflowDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.code !== undefined);
}

/**
 * The workflow files a definition runs by name, in step order, including from inside its inline workflows,
 * with the path of the step that runs each one, such as `group.run-b`.
 * Every walk across files, at pull and at start, follows references through here.
 */
export function workflowsRunBy(definition: { steps: WorkflowStep[] }, prefix = ''): Array<{ step: string; workflow: string }> {
  return definition.steps.flatMap((step) => (typeof step.workflow === 'object' ? workflowsRunBy(step.workflow, `${prefix}${step.id}.`)
    : step.workflow === undefined ? [] : [{ step: `${prefix}${step.id}`, workflow: step.workflow }]));
}

/**
 * Settles what each file runs after this sync: this revision when it passes its checks against the
 * workflows it runs, else the kept copy when nothing dropped it and it still fits them, else nothing.
 * A child is settled before its parent is checked against it, so a child with no runnable version is
 * reported on its parent, and a kept parent never reads an output or end its child no longer declares.
 */
function checkReferences(checked: Checked[], kept: Map<string, CachedWorkflow | null>): (stem: string) => Settled {
  const candidates = new Map(checked.flatMap((file) => ('definition' in file ? [[file.stem, file] as const] : [])));
  const settled = new Map<string, Settled>();
  const settling = new Set<string>();
  // Recursion follows the version each file asks to run: this revision when it passed its own checks, else the kept one.
  const asked = (workflow: string): WorkflowDefinition | null => candidates.get(workflow)?.definition ?? kept.get(workflow)?.definition ?? null;
  const cycleBack = (from: string, to: string): string[] | undefined => {
    const seen = new Set<string>();
    const walk = (workflow: string, through: string[]): string[] | undefined => {
      if (workflow === to) return [...through, workflow];
      if (seen.has(workflow)) return undefined;
      seen.add(workflow);
      const definition = asked(workflow);
      for (const { workflow: next } of definition ? workflowsRunBy(definition) : []) {
        const cycle = walk(next, [...through, workflow]);
        if (cycle) return cycle;
      }
      return undefined;
    };
    return walk(from, [to]);
  };
  // Called only through settle, which settles each file once.
  const check = (stem: string, version: Version): WorkflowDiagnostic[] => {
    const files: WorkflowFiles = { runnable: (workflow) => settle(workflow).definition, cycle: (workflow) => cycleBack(workflow, stem) };
    const parsed = parseWorkflow(version.relativePath, version.content, files);
    const diagnostics = parsed.ok ? [] : parsed.diagnostics;
    const promptFiles = (steps: WorkflowStep[], trail: number[]): void => steps.forEach((step, index) => {
      if (typeof step.workflow === 'object') promptFiles(step.workflow.steps, [...trail, index]);
      if (step.promptFile === undefined || step.prompt === undefined) return;
      const at = version.promptFileLocations[stepField([...trail, index])] ?? { line: 1, column: 1 };
      diagnostics.push(...promptFileDiagnostics(version.relativePath, version.definition, [...trail, index], step.prompt, at, files));
    });
    promptFiles(version.definition.steps, []);
    return diagnostics;
  };
  // A kept copy was checked against the workflows it ran then. Those may have changed since, so it is checked again.
  const checkKept = (stem: string, cached: CachedWorkflow): WorkflowDiagnostic[] => {
    if (workflowsRunBy(cached.definition).length === 0) return [];
    if (cached.content === undefined) {
      return [{ file: cached.relativePath, line: 1, column: 1, field: '(root)', message: 'it was cached without its source, so it cannot be checked against the workflows it runs' }];
    }
    const parsed = parseWorkflow(cached.relativePath, cached.content);
    if (!parsed.ok) return parsed.diagnostics;
    const { relativePath, content, definition } = cached;
    return check(stem, { relativePath, content, definition, promptFileLocations: parsed.promptFileLocations });
  };
  const settle = (stem: string): Settled => {
    const known = settled.get(stem);
    if (known) return known;
    // Reached again while one of its versions is checked: the versions being checked run each other in a cycle.
    if (settling.has(stem)) return { definition: null, revision: [], kept: [] };
    settling.add(stem);
    const candidate = candidates.get(stem);
    const revision = candidate ? check(stem, candidate) : [];
    let outcome: Settled;
    if (candidate && revision.length === 0) {
      outcome = { definition: candidate.definition, revision, kept: [] };
    } else {
      const cached = dropsKeptVersion(revision) ? null : kept.get(stem) ?? null;
      const problems = cached ? checkKept(stem, cached) : [];
      outcome = { definition: cached && problems.length === 0 ? cached.definition : null, revision, kept: problems };
    }
    settling.delete(stem);
    settled.set(stem, outcome);
    return outcome;
  };
  return settle;
}

/** Resolves every `prompt_file`, including those inside inline workflows. */
async function resolvePromptFiles(
  config: LocalConfig,
  definition: WorkflowDefinition,
  locations: Record<string, { line: number; column: number }>,
  workflowFile: string,
): Promise<
  | { ok: true; definition: WorkflowDefinition; sources: Array<{ path: string; content: string }> }
  | { ok: false; diagnostics: WorkflowDiagnostic[] }
> {
  const root = path.resolve(config.repo.localPath);
  const diagnostics: WorkflowDiagnostic[] = [];
  const sources: Array<{ path: string; content: string }> = [];
  const resolveSteps = async (given: WorkflowStep[], trail: number[]): Promise<WorkflowStep[]> => {
    const steps = [...given];
    for (const [index, step] of given.entries()) {
      const field = stepField([...trail, index]);
      if (typeof step.workflow === 'object') {
        steps[index] = { ...step, workflow: { ...step.workflow, steps: await resolveSteps(step.workflow.steps, [...trail, index]) } };
        continue;
      }
      if (!step.promptFile) continue;
      const target = path.resolve(root, step.promptFile);
      const location = locations[field] ?? { line: 1, column: 1 };
      let prompt: string | null = null;
      try {
        assertWithinRoot(path.join(root, 'prompts'), target);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
        assertSafePath(target, [root]);
        prompt = await readFileSafe(target);
        if (prompt === null) throw new Error('unreadable');
      } catch {
        diagnostics.push({
          file: workflowFile,
          line: location.line,
          column: location.column,
          field: `${field}.prompt_file`,
          message: `prompt_file "${step.promptFile}" must be a readable, non-symlink file under prompts/`,
        });
        continue;
      }
      diagnostics.push(...promptFileDiagnostics(workflowFile, definition, [...trail, index], prompt, location));
      sources.push({ path: step.promptFile, content: prompt });
      steps[index] = { ...step, prompt };
    }
    return steps;
  };
  const steps = await resolveSteps(definition.steps, []);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, definition: { ...definition, steps }, sources };
}
