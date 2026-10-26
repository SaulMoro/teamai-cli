/**
 * Benchmark suites and their tasks, as team files: `benchmarks/<suite>/suite.yaml` and
 * `benchmarks/<suite>/tasks/<task>.yaml`. Each file is parsed once, here, into the domain types below.
 *
 * `syncWorkflowDefinitions` calls `parseSuite` in the same tree walk that syncs scorers and workflows, and returns
 * suites as `result.benchmarks` with their diagnostics in `result.invalid`. Nothing after this module validates a suite
 * again.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { isYamlNode, locate } from '../parse-context.js';
import { durationMs } from '../parse.js';
import { SetupSchema, type Setup } from '../requirements.js';
import type { WorkflowDiagnostic } from '../types.js';
import { BENCHMARK_NAME, BenchmarkNameSchema, CommitSchema } from './terms.js';

/** The project the tasks start from. A URL, never a local path or a URL with credentials: it travels in plan and record. */
const RepoUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'ssh:', 'git:'].includes(url.protocol) && url.username === '' && url.password === '';
}, 'must be an https, ssh or git URL without credentials');

/**
 * A git pathspec relative to the repo; globs allowed (`test/**`). Passed to git as an argv element, never through a shell.
 * Written as git lists paths, segment by segment and with no glob escape, so a protected path is compared with a
 * submodule's as git would.
 */
const RepoPathSchema = z.string().min(1).refine(
  (value) => !value.startsWith(':') && !value.includes('\\') && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  'must be a path relative to the repo, with no backslash and no ".", ".." or empty segment',
);

const DurationSchema = z.string({ required_error: 'timeout is required: the run\'s timeout, such as 6h' }).transform((text, ctx): number => {
  const ms = durationMs(text);
  if (ms !== undefined) return ms;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a positive duration, such as 30m or 6h' });
  return z.NEVER;
});

/**
 * The keys a suite's `defaults` sets and an arm may change. Arm validation reads the key list from this schema, so a new
 * key is added here and nowhere else. Not a workflow's `defaults`.
 */
const ArmValuesSchema = z.object({
  tool: z.string().min(1),
  /** A model alias from models/aliases.yaml, or a model name. An alias resolves per tool; a name does not. */
  model: z.string().min(1).optional(),
}).strict();
export type ArmValues = z.infer<typeof ArmValuesSchema>;
type ArmKey = keyof ArmValues;
const ARM_KEYS = ArmValuesSchema.keyof().options;

const ArmFileSchema = ArmValuesSchema.partial().extend({ name: BenchmarkNameSchema }).strict();

const SuiteFileSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: BenchmarkNameSchema,
  description: z.string().optional(),
  repo: RepoUrlSchema,
  defaults: ArmValuesSchema,
  arms: z.array(ArmFileSchema).nonempty('a suite has 1 to 6 arms').max(6, 'a suite has 1 to 6 arms'),
  repetitions: z.number().int().min(1).max(10).default(3),
  /** Required: the run's timeout. */
  timeout: DurationSchema,
  setup: SetupSchema.optional(),
  scorers: z.array(z.string().min(1)).default([]),
}).strict().superRefine((suite, ctx) => {
  const seen = new Set<string>();
  let unchanged: string | undefined;
  suite.arms.forEach((arm, index) => {
    if (seen.has(arm.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms', index, 'name'], message: `arm "${arm.name}" is named twice; arm names are unique` });
    }
    seen.add(arm.name);
    const changed = changedKeys(suite.defaults, arm);
    if (changed.length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms', index], message: `arm "${arm.name}" changes ${changed.join(' and ')}; an arm changes at most one of the defaults keys` });
    } else if (changed.length === 0 && unchanged !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms', index], message: `arm "${arm.name}" changes none of the defaults keys, and neither does arm "${unchanged}"; at most one arm changes none` });
    } else if (changed.length === 0) {
      unchanged = arm.name;
    }
  });
});

/** The defaults keys `arm` sets to a value other than the defaults'. */
function changedKeys(defaults: ArmValues, arm: Partial<ArmValues>): ArmKey[] {
  return ARM_KEYS.filter((key) => arm[key] !== undefined && arm[key] !== defaults[key]);
}

/** One segment of a glob pathspec as a regular expression, undefined when its `[` class never closes. A class stays a class, `[!a]` as `[^a]`. */
function segmentPattern(segment: string): RegExp | undefined {
  const pattern = segment.replace(/[.+${}()|\\]/g, (char) => `\\${char}`).replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\[!/g, '[^');
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return undefined;
  }
}

const CheckFileSchema = z.object({
  run: z.string().trim().min(1, 'check.run is a command'),
  protect: z.array(RepoPathSchema.refine((value) => value.split('/').every((segment) => segmentPattern(segment) !== undefined), 'has a [ class with no closing ]'))
    .nonempty('check.protect lists every path the check reads and the agent must not supply'),
  /** Files as `source.fix` has them, such as its test, written before the check whether or not the starting commit has them: the agent never sees them. */
  add: z.array(RepoPathSchema.refine((value) => !/[*?[]/.test(value), 'must name one file, without glob characters')).nonempty().optional(),
}).strict();

/**
 * Whether glob pathspec `spec` names `file`, as git matches `:(glob)` pathspecs: `*` and `?` within one segment, a
 * `**` segment for any number of them, and a spec that names a directory for everything under it.
 */
function pathspecMatches(spec: readonly string[], file: readonly string[]): boolean {
  const [head, ...rest] = spec;
  if (head === undefined) return true;
  if (head === '**') return rest.length === 0 || file.some((_, at) => pathspecMatches(rest, file.slice(at)));
  const [name, ...below] = file;
  if (name === undefined) return false;
  return segmentPattern(head)?.test(name) === true && pathspecMatches(rest, below);
}

const TaskFileSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  title: z.string().min(1),
  prompt: z.string().min(1),
  startingCommit: CommitSchema,
  check: CheckFileSchema.optional(),
  successCriteria: z.string().trim().min(1).optional(),
  /** The session the task came from, and the commit that fixed it there, which `--try` checks the check passes at. */
  source: z.object({ platform: z.string().min(1), sessionId: z.string().min(1), fix: CommitSchema.optional() }).strict().optional(),
}).strict().transform(({ check, successCriteria, ...task }, ctx) => {
  if (successCriteria !== undefined && !check) return { ...task, judge: { kind: 'criteria', successCriteria } satisfies TaskJudge };
  if (!check || successCriteria !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['check'], message: 'a task has exactly one of check and successCriteria' });
    return z.NEVER;
  }
  const { add, ...rest } = check;
  if (!add) return { ...task, judge: { kind: 'check', ...rest } satisfies TaskJudge };
  const fix = task.source?.fix;
  if (fix === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['check', 'add'], message: 'check.add writes its files from source.fix; add source.fix, the full commit that brought them' });
    return z.NEVER;
  }
  const outside = add.findIndex((entry) => !rest.protect.some((spec) => pathspecMatches(spec.split('/'), entry.split('/'))));
  if (outside !== -1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['check', 'add', outside], message: `check.add "${add[outside]}" is not under check.protect, so the agent could supply it; add a protect path that covers it` });
    return z.NEVER;
  }
  return { ...task, judge: { kind: 'check', ...rest, add: { commit: fix, paths: add } } satisfies TaskJudge };
});

/** How a task is decided. Exactly one, by construction: the file rule above becomes a union here. */
export type TaskJudge =
  /** `add`: the files written from `commit`, the task's fix, before the check. */
  | { kind: 'check'; run: string; protect: [string, ...string[]]; add?: { commit: string; paths: [string, ...string[]] } }
  | { kind: 'criteria'; successCriteria: string };

export interface Task {
  /** The file name without `.yaml`. Trials are ordered by it. */
  id: string;
  /** Team-repo-relative path, such as `benchmarks/auth/tasks/expired-token.yaml`. */
  relativePath: string;
  title: string;
  prompt: string;
  startingCommit: string;
  judge: TaskJudge;
  source?: { platform: string; sessionId: string; fix?: string };
  /** sha256 of the file bytes. */
  sourceHash: string;
}

/** An arm with the defaults applied. */
export interface Arm extends ArmValues {
  name: string;
}

export interface Suite {
  name: string;
  relativePath: string;
  description?: string;
  repo: string;
  defaults: ArmValues;
  arms: [Arm, ...Arm[]];
  repetitions: number;
  timeoutMs: number;
  setup?: Setup;
  scorers: string[];
  /** The valid tasks, in file-name order. Never empty. */
  tasks: [Task, ...Task[]];
  sourceHash: string;
}

/** One team file as the sync read it. */
export interface SourceFile {
  relativePath: string;
  content: string;
}

export type SuiteParse =
  /** `diagnostics` holds the invalid task files; the suite runs without those tasks. `warnings` fail nothing. */
  | { ok: true; suite: Suite; diagnostics: WorkflowDiagnostic[]; warnings: WorkflowDiagnostic[] }
  | { ok: false; diagnostics: [WorkflowDiagnostic, ...WorkflowDiagnostic[]] };

/**
 * Parses one suite directory. Diagnostics read `file:line: field "...": message` like workflows, with the line of the
 * YAML node a zod issue's path names. `isAlias` says whether a model value is a team alias under the sync's selection:
 * a model name in `defaults.model` while an arm changes the tool is a warning, since a name does not resolve per tool.
 * Without it, nothing is checked against aliases.
 */
export function parseSuite(input: { suite: SourceFile; tasks: readonly SourceFile[]; isAlias?: (model: string) => boolean }): SuiteParse {
  const parsed = parseFile(input.suite, SuiteFileSchema);
  if (!parsed.ok) return parsed;
  const { value: file, document, lineCounter } = parsed;
  const directory = path.posix.basename(path.posix.dirname(input.suite.relativePath));
  if (file.name !== directory) {
    return { ok: false, diagnostics: [diagnosticAt(input.suite.relativePath, lineCounter, document, ['name'], `suite "${file.name}" must be named after its directory, "${directory}"`)] };
  }
  const diagnostics: WorkflowDiagnostic[] = [];
  const tasks: Task[] = [];
  for (const source of [...input.tasks].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const id = path.posix.basename(source.relativePath, '.yaml');
    if (!BENCHMARK_NAME.test(id)) {
      diagnostics.push({ file: source.relativePath, line: 1, column: 1, field: '(file)', message: 'a task file name must be letters, digits, "-" or "_", with no "."' });
      continue;
    }
    const task = parseFile(source, TaskFileSchema);
    if (!task.ok) {
      diagnostics.push(...task.diagnostics);
      continue;
    }
    const { title, prompt, startingCommit, judge, source: origin } = task.value;
    tasks.push({ id, relativePath: source.relativePath, title, prompt, startingCommit, judge, ...(origin ? { source: origin } : {}), sourceHash: hashOf(source.content) });
  }
  const [first, ...rest] = tasks;
  if (!first) {
    return { ok: false, diagnostics: [{ file: input.suite.relativePath, line: 1, column: 1, field: 'tasks', message: `suite ${file.name} has no valid task` }, ...diagnostics] };
  }
  const arm = ({ name, ...values }: z.infer<typeof ArmFileSchema>): Arm => ({ name, ...file.defaults, ...values });
  const [firstArm, ...otherArms] = file.arms;
  const toolArm = file.arms.find((candidate) => changedKeys(file.defaults, candidate).includes('tool'));
  const model = file.defaults.model;
  const warnings = model !== undefined && toolArm && input.isAlias && !input.isAlias(model)
    ? [diagnosticAt(input.suite.relativePath, lineCounter, document, ['defaults', 'model'], `defaults.model "${model}" is a model name, not an alias in models/aliases.yaml, and arm "${toolArm.name}" changes the tool; use an alias that names a model for each tool`)]
    : [];
  return {
    ok: true,
    suite: {
      name: file.name,
      relativePath: input.suite.relativePath,
      ...(file.description !== undefined ? { description: file.description } : {}),
      repo: file.repo,
      defaults: file.defaults,
      arms: [arm(firstArm), ...otherArms.map(arm)],
      repetitions: file.repetitions,
      timeoutMs: file.timeout,
      ...(file.setup ? { setup: file.setup } : {}),
      scorers: file.scorers,
      tasks: [first, ...rest],
      sourceHash: hashOf(input.suite.content),
    },
    diagnostics,
    warnings,
  };
}

type FileParse<T> =
  | { ok: true; value: T; document: ReturnType<typeof parseDocument>; lineCounter: LineCounter }
  | { ok: false; diagnostics: [WorkflowDiagnostic, ...WorkflowDiagnostic[]] };

function parseFile<T>({ relativePath, content }: SourceFile, schema: z.ZodType<T, z.ZodTypeDef, unknown>): FileParse<T> {
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter, uniqueKeys: true });
  const errors = document.errors.map((error): WorkflowDiagnostic => {
    const position = lineCounter.linePos(error.pos[0]);
    return { file: relativePath, line: position.line, column: position.col, field: '(document)', message: error.message };
  });
  const value: unknown = errors.length > 0 ? undefined : document.toJS();
  const result = errors.length > 0 ? undefined : schema.safeParse(value);
  if (result?.success) return { ok: true, value: result.data, document, lineCounter };
  const diagnostics = result ? result.error.issues.map((issue) => diagnosticAt(relativePath, lineCounter, document, issue.path, issue.message)) : errors;
  const [first, ...rest] = diagnostics;
  return { ok: false, diagnostics: [first ?? { file: relativePath, line: 1, column: 1, field: '(root)', message: 'file is empty' }, ...rest] };
}

function diagnosticAt(file: string, lineCounter: LineCounter, document: ReturnType<typeof parseDocument>, at: ReadonlyArray<string | number>, message: string): WorkflowDiagnostic {
  const node: unknown = at.length > 0 ? document.getIn(at, true) : document.contents;
  return locate(file, lineCounter, isYamlNode(node) ? node : undefined, at.join('.') || '(root)', message);
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
