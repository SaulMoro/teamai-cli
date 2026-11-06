import fs from 'node:fs';
import path from 'node:path';
import { ConfinedKeptSchema, OpIdSchema, OpStateSchema, RUN_DIR_ENV, type OpId } from '@teamai/runtime-protocol';
import { z } from 'zod';

// ─── The journal ─────────────────────────────────────────
//
//  What this runtime keeps across its own restarts, in a directory on the host:
//
//    places/<handle>.json   the attempt a handle opened, and the Paseo workspace that adopted its worktree once Paseo
//                           opened it, or, for a confined prompt's place, the prompt's directory
//    ops/<op>.json          a prompt: its handle, then the agent create it sends, whether it sent it and Paseo showed
//                           the agent, and once it ended, its outcome
//    ops/<op>.cancel        teamai cancelled it, written before the agent is cancelled: Paseo reports a cancelled
//                           agent as idle, so only this file tells a cancel from a finish
//    handles/<handle>/<op>  the prompts of a handle, written before each prompt's record, so a handle reads only its
//                           own records, and one that cannot be read stops only its own handle
//
//  The agent create is kept as sent, so a runtime started again sends the same one: Paseo answers a repeated
//  idempotency key with the agent it created, and refuses one whose request changed. Each file is written to a
//  temporary path and renamed into place. `close` removes a handle's files.
//

const WorkspaceSchema = z.object({ id: z.string(), name: z.string() });

/**
 * An attempt's place: a worktree a Paseo workspace adopted, or a confined prompt's, opened with no view of the host,
 * whose workspace adopts the prompt's directory once the prompt comes.
 */
const PlaceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('worktree'),
    run: z.string(),
    attempt: z.string(),
    /** Absent until Paseo opened the worktree: the open is accepted, and its handle kept, before. */
    workspace: WorkspaceSchema.optional(),
    /** The worktree: as teamai gave it until Paseo opened it, then as the workspace adopted it. */
    cwd: z.string(),
    /** The run's scratch directory, which the place's agents write at its own path. */
    runDir: z.string(),
  }),
  z.object({ kind: z.literal('confined'), run: z.string(), attempt: z.string(), workspace: WorkspaceSchema.optional() }),
]);

export type Place = z.infer<typeof PlaceSchema>;

/** The agent create a prompt sends, every field of it decided before it is first sent. */
const AgentCreateSchema = z.object({
  agentId: z.uuid(),
  idempotencyKey: z.string(),
  title: z.string(),
  prompt: z.string(),
  labels: z.record(z.string(), z.string()),
  /** The agent's environment: the run directory's name and nothing else, since Paseo keeps it in plain text. */
  env: z.strictObject({ [RUN_DIR_ENV]: z.string() }).optional(),
  config: z.object({
    provider: z.string(),
    /** Absent: the mode Paseo starts the tool in when it sets no default for it. */
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    /**
     * The provider's own launch options: for Claude, the tools it may use without asking; for Codex, the directories its
     * sandbox writes besides the worktree, or, for a confined prompt, a sandbox that writes nothing; for OpenCode, the
     * directories outside its project it may touch without asking.
     */
    options: z.union([
      z.strictObject({ allowedTools: z.array(z.string()) }),
      z.strictObject({ sandbox_workspace_write: z.strictObject({ writable_roots: z.array(z.string()) }) }),
      z.strictObject({ permission: z.strictObject({ external_directory: z.record(z.string(), z.literal('allow')) }) }),
      z.strictObject({ sandbox_mode: z.literal('read-only') }),
    ]).optional(),
  }),
});

export type AgentCreate = z.infer<typeof AgentCreateSchema>;

/**
 * A prompt: refused before it was accepted (its tool is not offered), accepted before Paseo was asked anything, or run
 * by an agent, with how it ended once it did. A pending prompt never sent a create: its agent record is journaled before
 * the create is sent, so a cancel that finds it pending ends it with no agent to stop.
 */
const PromptRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refused'), handle: z.string(), outcome: OpStateSchema }),
  z.object({ kind: z.literal('pending'), handle: z.string(), outcome: OpStateSchema.optional() }),
  z.object({
    kind: z.literal('agent'),
    handle: z.string(),
    tool: z.string(),
    /**
     * Where the answer comes from: the workflow result file the agent writes, or, for a confined prompt, its last
     * message, reported with the level and access the runtime kept.
     */
    answer: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('result-file'), file: z.string() }),
      z.object({ kind: z.literal('reply'), kept: ConfinedKeptSchema }),
    ]),
    /** The directory the agent works in: the worktree, or a confined prompt's directory. */
    cwd: z.string(),
    create: AgentCreateSchema,
    /**
     * Whether a create was sent: absent until one is about to be, which proves none was; `unconfirmed` once one may have
     * reached Paseo, which may still start its agent though the create failed; `confirmed` once Paseo showed the agent.
     */
    dispatched: z.enum(['unconfirmed', 'confirmed']).optional(),
    outcome: OpStateSchema.optional(),
  }),
]);

export type PromptRecord = z.infer<typeof PromptRecordSchema>;

export type AgentPrompt = Extract<PromptRecord, { kind: 'agent' }>;

/** A record, or undefined when there is none. A record that cannot be read or parsed is an error, never taken as absent. */
function read<T>(file: string, schema: z.ZodType<T>): T | undefined {
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }

  return schema.parse(JSON.parse(text));
}

/** A directory with its links resolved, as Paseo names a workspace's, or as given when it is gone. */
function resolved(directory: string): string {
  try {
    return fs.realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function write(file: string, value: Place | PromptRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function journal(root: string) {
  const placeFile = (handle: string): string => path.join(root, 'places', `${encodeURIComponent(handle)}.json`);
  const promptFile = (op: OpId): string => path.join(root, 'ops', `${op}.json`);
  const cancelFile = (op: OpId): string => path.join(root, 'ops', `${op}.cancel`);
  const names = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  const indexDir = (handle: string): string => path.join(root, 'handles', encodeURIComponent(handle));

  /** Every place, or, for one whose record cannot be read, its handle alone: what it holds is unknown, not absent. */
  const places = (): Array<{ handle: string; place?: Place }> => names(path.join(root, 'places')).flatMap((name) => {
    const handle = decodeURIComponent(name.replace(/\.json$/, ''));

    try {
      const place = read(placeFile(handle), PlaceSchema);

      return place ? [{ handle, place }] : [];
    } catch {
      return [{ handle }];
    }
  });

  /** The prompts `handle`'s index names; a record outside it is never read for `handle`. */
  const promptsOf = (handle: string): Array<{ op: OpId; record: PromptRecord }> => names(indexDir(handle)).flatMap((name) => {
    const op = OpIdSchema.safeParse(name);
    const record = op.success ? read(promptFile(op.data), PromptRecordSchema) : undefined;

    return op.success && record?.handle === handle ? [{ op: op.data, record }] : [];
  });

  return {
    place: (handle: string): Place | undefined => read(placeFile(handle), PlaceSchema),
    savePlace(handle: string, place: Place): void {
      fs.mkdirSync(indexDir(handle), { recursive: true });
      write(placeFile(handle), place);
    },
    /**
     * The handle already opened for an attempt, so a repeated open opens no second place. One whose record cannot be read
     * is the attempt's when its name says so, so the open fails on it rather than write a fresh record over it.
     */
    handleOf: ({ run, attempt }: { run: string; attempt: string }): string | undefined => places()
      .find(({ handle, place }) => (place ? place.run === run && place.attempt === attempt : handle.endsWith(`/${run}/${attempt}`)))?.handle,
    /**
     * The handles open on a Paseo workspace, which the last of them archives when it closes: those Paseo opened it for,
     * and those still being opened on its `directory`, which Paseo will open it for.
     */
    handlesIn: ({ id, directory }: { id: string; directory?: string }): string[] => places().filter(({ place }) => (!place
      // A place that cannot be read may be on this workspace: it counts as sharing it.
      ? true
      : place.workspace
        ? place.workspace.id === id
        : place.kind === 'worktree' && directory !== undefined && resolved(place.cwd) === resolved(directory))).map(({ handle }) => handle),
    prompt: (op: OpId): PromptRecord | undefined => read(promptFile(op), PromptRecordSchema),
    /** Where `op`'s record is kept, for a person to delete when a close says to. */
    promptFile,
    savePrompt(op: OpId, record: PromptRecord): void {
      // Indexed under the directory `savePlace` made: a handle `forget` removed gets none back.
      if (fs.existsSync(indexDir(record.handle))) fs.writeFileSync(path.join(indexDir(record.handle), op), '');
      write(promptFile(op), record);
    },
    promptsOf,
    cancel(op: OpId): void {
      fs.mkdirSync(path.dirname(cancelFile(op)), { recursive: true });
      fs.writeFileSync(cancelFile(op), '');
    },
    isCancelled: (op: OpId): boolean => fs.existsSync(cancelFile(op)),
    /** Removes everything kept for `handle`. */
    forget(handle: string): void {
      for (const { op } of promptsOf(handle)) {
        fs.rmSync(promptFile(op), { force: true });
        fs.rmSync(cancelFile(op), { force: true });
      }

      fs.rmSync(placeFile(handle), { force: true });
      fs.rmSync(indexDir(handle), { recursive: true, force: true });
    },
  };
}

export type Journal = ReturnType<typeof journal>;
