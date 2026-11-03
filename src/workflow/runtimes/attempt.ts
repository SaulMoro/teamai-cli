import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { storeDirOf } from '../../session-flow/adapters/index.js';
import { AgentSession } from '../../session-flow/agent-session.js';
import { homeEnvOf } from '../../tool-home.js';
import type { LaunchTool } from '../../tool-launch/tools.js';
import type { LocalConfig } from '../../types.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import { attemptDir, AttemptIdSchema, attemptsDir, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import { newOpId, OpIdSchema, type ExecEnd, type ExecEvents, type PlaceView, type StepRuntime } from './step-runtime.js';

// ─── An attempt on a step runtime ────────────────────────
//
//  attempts/<attempt>/runtime.json records which runtime an attempt runs on, the operation ids teamai sent it, and,
//  once accepted, the runtime's handle. Each id is written before its request is sent, so a teamai killed between a
//  runtime's reply and its own write sends the same id again (a repeated open returns the same handle) or reattaches
//  and reads the outcome the runtime retained. The attempt's tool home sits beside it, never in the member's home.
//

/** The tools a step runtime that execs can launch: their session store moves with one variable, into the attempt's tool home. */
// oxlint-disable-next-line teamai/tool-facts -- a fixed-id table of what step runtimes decided to run, kept apart from TOOLS on purpose; tools without one home variable (OpenCode, Pi) stay out
export const EXEC_RUNTIME_TOOLS = ['claude', 'codex', 'codebuddy'] as const satisfies readonly LaunchTool[];

export type ExecRuntimeTool = (typeof EXEC_RUNTIME_TOOLS)[number];

export function isExecRuntimeTool(tool: string): tool is ExecRuntimeTool {
  return EXEC_RUNTIME_TOOLS.some((known) => known === tool);
}


const PHASES = ['opening', 'ready', 'running', 'collected', 'closed'] as const;

export const AttemptRuntimeRecordSchema = z.object({
  /** The runtime the attempt runs on, as the definition's `use` names it. */
  runtime: z.string(),
  /** The driver definition that chose it. */
  driver: z.string(),
  phase: z.enum(PHASES),
  open: z.object({ op: OpIdSchema, handle: z.string().optional() }),
  exec: z.object({ op: OpIdSchema }).optional(),
  /** The attempt's tool home, for a prompt: the tool and its directory. */
  toolHome: z.object({ tool: z.string(), dir: z.string() }).optional(),
});

export type AttemptRuntimeRecord = z.infer<typeof AttemptRuntimeRecordSchema>;

function recordPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'runtime.json');
}

export async function readAttemptRuntime(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<AttemptRuntimeRecord | undefined> {
  try {
    return AttemptRuntimeRecordSchema.parse(JSON.parse(await fs.readFile(recordPath(config, run, attempt), 'utf8')));
  } catch {
    return undefined;
  }
}

/** The tool home of `tool` for attempt `attempt`: under the attempt directory, beside its record. */
export function attemptToolHome(config: LocalConfig, run: RunId, attempt: AttemptId, tool: string): string {
  return path.join(attemptDir(config, run, attempt), 'tool-home', tool);
}

/**
 * Where the sessions of attempt `attempt` of run `run` are: the store in the tool home its record names, or undefined
 * when it ran in the member's own home. Every lookup of a run step's session passes it on (`AgentSessionRef.storeDir`).
 */
export async function attemptSessionStore(config: LocalConfig, run: string, attempt: string | undefined): Promise<string | undefined> {
  const runId = RunIdSchema.safeParse(run);
  const attemptId = AttemptIdSchema.safeParse(attempt);

  if (!runId.success || !attemptId.success) return undefined;
  const home = (await readAttemptRuntime(config, runId.data, attemptId.data))?.toolHome;

  const platform = home && isExecRuntimeTool(home.tool) ? AgentSession.platformForTool(home.tool) : undefined;
  const store = home && platform ? storeDirOf(platform, { kind: 'tool-home', dir: home.dir }) : '';

  return store === '' ? undefined : store;
}

/**
 * The attempt of run `run` whose tool home holds session `session` of its tool, with that home's store, or undefined
 * when no attempt that ran on a step runtime holds it (the session is then in the member's own store, if anywhere).
 */
export async function attemptHoldingSession(config: LocalConfig, run: string, session: { tool: string; id: string }): Promise<{ attempt: AttemptId; home: string; storeDir: string } | undefined> {
  const runId = RunIdSchema.safeParse(run);
  const platform = AgentSession.platformForTool(session.tool);

  if (!runId.success || !platform) return undefined;
  const names = await fs.readdir(attemptsDir(config, runId.data)).catch(() => []);

  for (const name of names.sort()) {
    const attempt = AttemptIdSchema.safeParse(name);
    const home = attempt.success ? (await readAttemptRuntime(config, runId.data, attempt.data))?.toolHome : undefined;

    if (!attempt.success || home?.tool !== session.tool) continue;
    const storeDir = storeDirOf(platform, { kind: 'tool-home', dir: home.dir });

    if (storeDir === '') continue;
    const found = await AgentSession.find({ platform, sessionId: session.id, storeDir }, { scrub: false });

    if (found.status === 'done') return { attempt: attempt.data, home: home.dir, storeDir };
  }

  return undefined;
}

/** The variable `tool`'s session store follows, set to its home in the attempt, or undefined for a tool no exec runtime runs. */
export function toolHomeVariable(tool: string): string | undefined {
  return isExecRuntimeTool(tool) ? homeEnvOf(tool) : undefined;
}

/** What a restart found of an exec it had sent: the outcome, or that it was still running and is now stopped. */
export type AttemptExecEnd = ExecEnd | { kind: 'interrupted' };

/**
 * One attempt on a step runtime: it opens the place, runs one exec, and finishes with collect and close, each under an
 * id persisted in the attempt's record before it is sent. Built again after a restart, it reopens on the same handle and
 * reads the outcome of the exec it had sent instead of running it again.
 */
export interface AttemptRun {
  /** Opens the place; `toolHome` is the tool home a prompt's tool keeps its session in, recorded for every later lookup. */
  open(view: PlaceView, toolHome?: { tool: string; dir: string }): Promise<{ ok: true; handle: string } | { ok: false; failure: WorkflowFailure }>;
  exec(request: { argv: string[]; env: Record<string, string>; unset: string[]; cwd: string }, events: ExecEvents): Promise<AttemptExecEnd>;
  /** Stops the exec running now, with every process it started. */
  cancel(): Promise<void>;
  /** Brings the place's work back to the host, after success and after failure, before teamai reads the result or commits. */
  collect(): Promise<WorkflowFailure | undefined>;
  /** Closes the handle once the attempt's report is recorded, so a teamai killed before that still reattaches. */
  close(): Promise<void>;
}

/** How long a restarted teamai waits for an exec it found running to stop. */
const STOP_WAIT_MS = 15_000;

function runtimeFailure(runtime: string, message: string): WorkflowFailure {
  return { code: 'runtime_failed', message: `Step runtime "${runtime}" ${message}` };
}

export function attemptRun({ config, run, attempt, runtime, driver }: { config: LocalConfig; run: RunId; attempt: AttemptId; runtime: StepRuntime; driver: string }): AttemptRun {
  const file = recordPath(config, run, attempt);
  let record: AttemptRuntimeRecord | undefined;
  let running: AttemptRuntimeRecord['exec'];

  const save = async (next: AttemptRuntimeRecord): Promise<void> => {
    record = next;
    await writeJsonAtomic(file, next);
  };

  const current = async (): Promise<AttemptRuntimeRecord | undefined> => (record ??= await readAttemptRuntime(config, run, attempt));

  /** Stops an exec a teamai before this one left running, and waits until the runtime no longer reports it running. */
  const stopLeftRunning = async (handle: string, op: z.infer<typeof OpIdSchema>): Promise<void> => {
    await runtime.cancel(op);

    for (const deadline = Date.now() + STOP_WAIT_MS; Date.now() < deadline;) {
      const seen = await runtime.reattach(handle);

      if (seen.kind !== 'alive' || seen.ops.find((state) => state.op === op)?.state !== 'running') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  return {
    async open(view, home) {
      const before = await current();

      // The record names another runtime when the run is resumed with another driver: the attempt is not moved.
      if (before && before.runtime !== runtime.name) {
        return { ok: false, failure: runtimeFailure(runtime.name, `cannot continue attempt ${attempt}, which runs on step runtime "${before.runtime}" of driver "${before.driver}". Resume the run with --driver ${before.driver}, or retry the step.`) };
      }

      const op = before?.open.op ?? newOpId();
      const toolHome = home ?? before?.toolHome;
      const opening: AttemptRuntimeRecord = { runtime: runtime.name, driver, phase: before?.phase ?? 'opening', open: { op } };

      if (before?.open.handle) opening.open.handle = before.open.handle;

      if (before?.exec) opening.exec = before.exec;

      if (toolHome) opening.toolHome = toolHome;
      await save(opening);

      const opened = await runtime.open({ op, run, attempt, view, credentials: {} }, async (handle) => {
        const now = await current();

        if (now) await save({ ...now, open: { op, handle }, phase: now.phase === 'opening' ? 'ready' : now.phase });
      });

      return opened.kind === 'ready' ? { ok: true, handle: opened.handle } : { ok: false, failure: runtimeFailure(runtime.name, `could not open attempt ${attempt}: ${opened.failure.message}`) };
    },

    async exec(request, events) {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${attempt} has no open place to exec in.` } };

      if (before.exec) {
        const sent = before.exec;
        const found = await runtime.reattach(handle);

        if (found.kind === 'failed') return { kind: 'failed', failure: found.failure };

        if (found.kind === 'gone') return { kind: 'failed', failure: { code: 'runtime_gone', message: `The runtime no longer knows the place of attempt ${attempt}.` } };
        const state = found.ops.find((retained) => retained.op === sent.op);

        // The runtime accepted it before the restart.
        if (state !== undefined) events.onAccepted?.();

        if (state?.state === 'exited') return { kind: 'exited', code: state.code, stdout: state.stdout };

        if (state?.state === 'cancelled') return { kind: 'cancelled' };

        if (state?.state === 'failed') return { kind: 'failed', failure: state.failure };

        if (state?.state === 'running') {
          await stopLeftRunning(handle, sent.op);

          return { kind: 'interrupted' };
        }

        // The request never reached the runtime: it is sent now, under the id that was persisted for it.
      }

      const exec = before.exec ?? { op: newOpId() };
      await save({ ...before, exec, phase: 'running' });
      running = exec;
      const end = await runtime.exec({ op: exec.op, handle, ...request }, events);
      running = undefined;

      return end;
    },

    async cancel() {
      if (running) await runtime.cancel(running.op);
    },

    async collect() {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return undefined;
      const collected = await runtime.collect(handle);

      if (!collected.ok) return runtimeFailure(runtime.name, `could not bring the work of attempt ${attempt} back: ${collected.failure.message}. Nothing it changed in the place was committed.`);
      await save({ ...before, phase: 'collected' });

      return undefined;
    },

    async close() {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined || before.phase === 'closed') return;
      await runtime.close(handle);
      await save({ ...before, phase: 'closed' });
    },
  };
}
