import type { RuntimeFailure, RuntimeRequest } from '@teamai/runtime-protocol';
import { outerHandleOf, type Registration } from '@teamai/runtime-kit/outer';
import { findOnPath } from '@teamai/tool-core/lookpath';
import type { Daemon, Target } from './daemon/connect.js';
import type { AgentPrompt, Place } from './journal.js';
import type { ProcessState } from './process-state.js';
import { addedNotice, homeVariableOf } from './providers.js';

// ─── A place that runs through a sandbox ─────────────────
//
//  When a step runs `through: sandbox`, teamai opens its place in the sandbox runtime first and gives that handle here
//  as `outer`. Paseo then runs the step's tool as teamai's wrapper, `teamai-sandbox-<tool>`, on a provider of its own,
//  and the wrapper asks the sandbox, over the attempt socket, how to start the tool there. A prompt's agent is
//  registered on that socket before Paseo starts it, created with no prompt, and sent the prompt only once the sandbox
//  says its wrapper connected, so the prompt never reaches a tool that runs outside the sandbox:
//
//    registered ── create (no prompt) ── start ──┬── connected ── sent ── follows the agent
//                                                └── refused, failed, or 30 s ── agent removed, isolation_unproven
//
//  The registration lives in this process: a runtime that follows the prompt again registers again.
//

export type Through = NonNullable<Extract<Place, { kind: 'worktree' }>['through']>;

/** What `place` runs through, when it runs through a sandbox. */
export const throughOf = (place: Place | undefined): Through | undefined => (place?.kind === 'worktree' ? place.through : undefined);

/** How long a started agent's wrapper may take to connect: the sandbox grants it before the tool itself starts. */
const WRAPPER_CONNECT_MS = 30_000;

/** How often a starting agent is looked at for a tool that failed. */
const START_POLL_MS = 250;

/**
 * What a place opened with `outer` runs through: the attempt socket, the Paseo provider that runs the step's tool as
 * teamai's wrapper, added on a daemon on this machine when none runs it, and the attempt's tool home. Or why the place
 * cannot run through the sandbox here.
 */
export async function openThrough(state: ProcessState, live: Daemon, request: Extract<RuntimeRequest, { type: 'open' }> & { outer: string }, target: Target): Promise<Through | RuntimeFailure> {
  const { op, outer, view } = request;
  const outerHandle = outerHandleOf(outer);
  const cannot = (why: string): RuntimeFailure => ({ code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run ${target.name} through the sandbox on the Paseo daemon at ${live.url}: ${why}. Then run the step again.` });

  if (!outerHandle) return cannot('the outer runtime\'s handle names no attempt socket; run the step through the sandbox runtime');

  if (target.tool === 'opencode') return cannot('Paseo may serve several agents from one OpenCode server, so the sandbox cannot tell the step\'s agent from another; run OpenCode steps through the sandbox on another runtime');
  const id = `teamai-sandbox-${target.name}`;
  let release: () => void;

  try {
    release = await state.journal.holdProviders(live.url);
  } catch (error) {
    return cannot(`it could not hold the daemon's providers in ${state.journal.root} (${error instanceof Error ? error.message : String(error)}); make that directory writable`);
  }

  try {
    const found = findOnPath(id);
    const wrapper = await live.wrapperProvider({ id, tool: target.tool, found });

    if (wrapper.added && found !== null) state.write({ event: 'notice', op, message: addedNotice(live.url, { id, entry: { extends: target.tool, label: id, command: [found] } }, target.name) });

    if ('cannot' in wrapper) return cannot(wrapper.cannot);
    const home = view?.toolHome[homeVariableOf(target.tool)];

    return { socket: outerHandle.socket, provider: wrapper.provider, ...(home !== undefined && { home }) };
  } finally {
    release();
  }
}

/**
 * Starts a prompt's idle agent, which Paseo runs on the wrapper, and sends it the prompt once `registration` says its
 * wrapper connected, after `markSent`; else removes the agent, and says why. `stopped` once the prompt is stopped first.
 */
export async function handOver(live: Daemon, { record, provider, registration, stopped, markSent }: {
  record: AgentPrompt; provider: string; registration: Registration; stopped: Promise<'stopped'>; markSent: () => void;
}): Promise<'sent' | 'stopped' | RuntimeFailure> {
  const { agentId, prompt } = record.create;
  const never = new Promise<never>(() => {});
  const starting = new AbortController();

  const startFailed = (async (): Promise<string> => {
    try {
      await live.start(agentId);

      return await never;
    } catch (error) {
      return `Paseo could not start it: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();

  const toolFailed = (async (): Promise<string> => {
    while (!starting.signal.aborted) {
      const agent = await live.agent(agentId).catch(() => undefined);

      if (agent?.status === 'error') return `its tool failed: ${agent.lastError ?? 'Paseo gives no error'}`;
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }

    return never;
  })();

  let timer: NodeJS.Timeout | undefined;

  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`it did not connect within ${WRAPPER_CONNECT_MS / 1000} s`), WRAPPER_CONNECT_MS);
  });

  const outcome = await Promise.race([registration.connected.then((connected) => (connected.ok ? 'connected' as const : connected.why)), startFailed, toolFailed, late, stopped]);
  starting.abort();
  clearTimeout(timer);

  if (outcome === 'stopped') return 'stopped';

  if (outcome === 'connected') {
    markSent();

    try {
      await live.send(agentId, prompt);

      return 'sent';
    } catch (error) {
      return { code: 'paseo_failed', message: `Paseo did not take the prompt for the ${record.tool} agent ${agentId}, which runs in the sandbox: ${error instanceof Error ? error.message : String(error)}. It may still have reached the agent; stop it in the Paseo app.` };
    }
  }

  const removal = await (async (): Promise<string> => {
    try {
      await live.remove(agentId);

      return 'removed the agent';
    } catch (error) {
      return `could not remove the agent (${error instanceof Error ? error.message : String(error)}); remove it in the Paseo app`;
    }
  })();

  return {
    code: 'isolation_unproven',
    message: `The ${record.tool} agent ${agentId} started on Paseo provider ${provider}, but its wrapper did not connect to the attempt's sandbox (${outcome}), so teamai never sent it the prompt, and ${removal}. Check that the provider runs teamai-sandbox-${record.tool}, and that the daemon starts it with the HOME teamai runs with, where it finds the attempt; the Paseo daemon's log says why it stopped. Then run the step again.`,
  };
}
