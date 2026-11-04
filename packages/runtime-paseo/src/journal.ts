import fs from 'node:fs';
import path from 'node:path';
import { OpIdSchema, OpStateSchema, type OpId } from '@teamai/runtime-protocol';
import { z } from 'zod';

// ─── The journal ─────────────────────────────────────────
//
//  What this runtime keeps across its own restarts, in a directory on the host:
//
//    places/<handle>.json   the attempt a handle opened, and the Paseo workspace that adopted its worktree
//    ops/<op>.json          a prompt: its handle, the agent create it sends, and once it ended, its outcome
//    ops/<op>.cancel        teamai cancelled it, written before the agent is cancelled: Paseo reports a cancelled
//                           agent as idle, so only this file tells a cancel from a finish
//
//  The agent create is kept as sent, so a runtime started again sends the same one: Paseo answers a repeated
//  idempotency key with the agent it created, and refuses one whose request changed. Each file is written to a
//  temporary path and renamed into place. `close` removes a handle's files.
//

const PlaceSchema = z.object({
  run: z.string(),
  attempt: z.string(),
  workspace: z.object({ id: z.string(), name: z.string() }),
  /** The worktree the workspace adopted. */
  cwd: z.string(),
  /** The run's scratch directory, which the place's agents write at its own path. */
  runDir: z.string(),
});

export type Place = z.infer<typeof PlaceSchema>;

/** The agent create a prompt sends, every field of it decided before it is first sent. */
const AgentCreateSchema = z.object({
  agentId: z.uuid(),
  idempotencyKey: z.string(),
  title: z.string(),
  prompt: z.string(),
  labels: z.record(z.string(), z.string()),
  config: z.object({
    provider: z.string(),
    modeId: z.string(),
    thinkingOptionId: z.string().optional(),
    /** The provider's own launch options: for Claude, the tools it may use without asking. */
    options: z.object({ allowedTools: z.array(z.string()) }).optional(),
  }),
});

export type AgentCreate = z.infer<typeof AgentCreateSchema>;

/**
 * A prompt: refused before any agent was created (its model is not there), or run by an agent, with how it ended once
 * it did.
 */
const PromptRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refused'), handle: z.string(), outcome: OpStateSchema }),
  z.object({
    kind: z.literal('agent'),
    handle: z.string(),
    tool: z.string(),
    /** The file the agent writes the workflow result to. */
    result: z.string(),
    /** The worktree the agent works in. */
    cwd: z.string(),
    create: AgentCreateSchema,
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

  const places = (): Array<{ handle: string; place: Place }> => names(path.join(root, 'places')).flatMap((name) => {
    const handle = decodeURIComponent(name.replace(/\.json$/, ''));
    const place = read(placeFile(handle), PlaceSchema);

    return place ? [{ handle, place }] : [];
  });

  const promptsOf = (handle: string): Array<{ op: OpId; record: PromptRecord }> => names(path.join(root, 'ops')).flatMap((name) => {
    const op = OpIdSchema.safeParse(name.replace(/\.json$/, ''));
    const record = name.endsWith('.json') && op.success ? read(promptFile(op.data), PromptRecordSchema) : undefined;

    return op.success && record?.handle === handle ? [{ op: op.data, record }] : [];
  });

  return {
    place: (handle: string): Place | undefined => read(placeFile(handle), PlaceSchema),
    savePlace: (handle: string, place: Place): void => write(placeFile(handle), place),
    /** The handle already opened for an attempt, so a repeated open opens no second place. */
    handleOf: ({ run, attempt }: { run: string; attempt: string }): string | undefined => places().find(({ place }) => place.run === run && place.attempt === attempt)?.handle,
    /** The handles open on a Paseo workspace, which the last of them archives when it closes. */
    handlesIn: (workspaceId: string): string[] => places().filter(({ place }) => place.workspace.id === workspaceId).map(({ handle }) => handle),
    prompt: (op: OpId): PromptRecord | undefined => read(promptFile(op), PromptRecordSchema),
    savePrompt: (op: OpId, record: PromptRecord): void => write(promptFile(op), record),
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
    },
  };
}

export type Journal = ReturnType<typeof journal>;
