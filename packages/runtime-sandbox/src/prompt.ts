import { CANCEL_FAILED, PromptResultSchema, type OpId, type PromptRequestSchema, type RuntimeFailure } from '@teamai/runtime-protocol';
import type { OpLedger } from '@teamai/runtime-kit/ledger';
import { redact, redactJson } from '@teamai/shared/redact';
import type { z } from 'zod';
import { placeOf } from './attempt-socket.js';
import type { ExecOperations } from './exec.js';
import type { Journal, Outcome } from './journal.js';
import { EVIDENCE_DIR, inEvidenceDir, judgeOf } from './judge.js';
import { inSandbox, maskedAsGiven, rewrittenMasks } from './loopback.js';
import type { Ready } from './runtime.js';

// ─── A judge in a sandbox ────────────────────────────────
//
//  A confined prompt is a judge: its place opens with no view, and the prompt runs its tool in a container of its own
//  that sees only the prompt's directory, read-only (judge.ts). It runs under teamai's id as an exec does.
//

type PromptRequest = z.infer<typeof PromptRequestSchema>;

/** Runs a judge's prompt, over `execs`, in a container `creation` lets a close of its place wait for. */
export function judgePrompts({ journal, ledger, env, execs, creation }: {
  journal: Journal;
  ledger: OpLedger;
  env: NodeJS.ProcessEnv;
  execs: ExecOperations;
  creation: <T>(handle: string, work: Promise<T>) => Promise<T>;
}) {
  const { write } = ledger;
  const { claim, finish, replay } = execs;

  /** Ends `op` failed with `failure`, before this process ran anything of it. */
  const fail = (op: OpId, failure: RuntimeFailure): void => ledger.end({ op, state: 'failed', failure });

  /** Runs a judge: its tool in a sandbox of its own that sees only the prompt's directory, read-only. */
  const prompt = async (request: PromptRequest, { provider, can, host }: Ready): Promise<void> => {
    const { op, confined, lease } = request;
    const handle = placeOf(request.handle);

    if (confined === undefined) {
      fail(op, { code: 'prompt_unsupported', message: 'The sandbox runtime runs the tool teamai builds, as an exec, and launches no agent of its own.' });

      return;
    }

    const replayed = replay(op);

    if (replayed) return replayed;
    const place = journal.place(handle);

    if (!place?.confined) {
      fail(op, { code: 'bad_request', message: `Prompt ${op} is confined, and handle ${handle} is not a judge's place. Open one with no view first.` });

      return;
    }

    const { judges } = provider;

    if (!judges || !can.confined?.some((offer) => offer.tools.includes(lease.tool))) {
      fail(op, { code: 'tool_unavailable', message: `The sandbox offers no ${lease.tool} judge: it judges on ${can.confined?.flatMap((offer) => offer.tools).join(', ') || 'no tool'}.` });

      return;
    }

    const given = inSandbox(request.credentials, host);
    const chosen = judgeOf(lease.tool, given, env);

    if (!chosen.ok) {
      fail(op, chosen.failure);

      return;
    }

    // Claimed before the first await, as an exec is.
    claim(op);
    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    const { judge } = chosen;

    // The journal never holds a credential the tool echoed into its reply. Only its strings are masked: a setting such
    // as `1` leaves a reply's numbers as they are.
    // teamai masks the reply with the values it gave; a value the sandbox got rewritten is masked here first.
    const masks = maskedAsGiven(request.credentials, given);
    const rewritten = rewrittenMasks(request.credentials, given);
    const replyMasked = (outcome: Outcome, envSecrets: Record<string, string>): Outcome => (outcome.state === 'finished' ? { ...outcome, result: PromptResultSchema.parse(redactJson(outcome.result, envSecrets)) } : outcome);
    const settle = (outcome: Outcome): void => finish(op, replyMasked(outcome, rewritten), replyMasked(outcome, masks));

    /** The judge's container, or undefined once the prompt settled: its creation failed, or a cancel came meanwhile. */
    const create = async (): Promise<string | undefined> => {
      const created = await judges.create(place, { dir: confined.dir, hosts: judge.hosts });

      if (!created.ok) {
        settle(journal.isCancelled(op) ? { state: 'cancelled' } : { state: 'failed', failure: created.failure });

        return undefined;
      }

      // A place a released close forgot meanwhile stays forgotten, as an open's does.
      if (journal.place(handle) !== undefined) journal.savePlace(handle, { ...place, id: created.id });

      if (!journal.isCancelled(op)) return created.id;
      // A creation a cancel or a close overtook removes the container it made before it settles; the filter and the
      // network stay for close.
      const removed = await provider.destroy(created.id);
      settle(removed.ok ? { state: 'cancelled' } : { state: 'failed', failure: { code: CANCEL_FAILED, message: removed.failure.message } });

      return undefined;
    };

    // A close waits for this to settle, however it does, so the removal after it finds whatever the creation made.
    const id = await creation(handle, create());

    if (id === undefined) return;

    const launch = judge.tool.launch({ ...lease, prompt: inEvidenceDir(lease.prompt, confined.dir) }, confined);
    // Only the credentials the judge's own tool reads, less any the prompt withholds.
    const scoped = Object.fromEntries(Object.entries(judge.credentials).filter(([name]) => !request.unset.includes(name)));
    let stdout = '';
    let stderr = '';

    const ran = await provider.exec(id, { argv: launch.argv, env: { ...scoped, ...launch.env, ...request.env }, unset: request.unset, cwd: EVIDENCE_DIR }, (stream, data) => {
      if (stream === 'stdout') stdout += data;
      else stderr = `${stderr}${data}`.slice(-4000);
    });

    if (journal.isCancelled(op)) {
      settle({ state: 'cancelled' });

      return;
    }

    if (ran.kind === 'failed') {
      settle({ state: 'failed', failure: ran.failure });

      return;
    }

    const reading = judge.tool.read(stdout);
    const masked = (text: string): string => redact(text, { envSecrets: masks, patterns: false });

    if (ran.code !== 0) {
      const lastStderr = stderr.trim().split('\n').at(-1) || 'it printed nothing on stderr';
      settle({ state: 'failed', failure: { code: 'tool_failed', message: masked(`${lease.tool} exited with code ${ran.code} in the judge's container: ${reading.ok ? lastStderr : reading.message}`) } });

      return;
    }

    if (!reading.ok) {
      settle({ state: 'failed', failure: { code: 'tool_failed', message: masked(`${lease.tool} ended in the judge's container without a reply: ${reading.message}`) } });

      return;
    }

    settle({ state: 'finished', session: { tool: lease.tool, id: reading.session }, result: reading.result, ...(reading.usage && { usage: reading.usage }), confined: { level: 'verified', access: judge.tool.access } });
  };

  return (request: PromptRequest, current: Ready): Promise<void> => execs.guarded(request, () => prompt(request, current));
}
