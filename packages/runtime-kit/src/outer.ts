import net from 'node:net';
import { z } from 'zod';

// ─── A place through an outer runtime ───
//
//  An app's runtime (T3 Code, Paseo) whose entry runs through a sandbox (`use: t3, through: sandbox`) gets the outer's
//  handle as `open.outer`: JSON with the attempt socket the sandbox serves its wrapper on. Before the app starts the
//  step's tool, the runtime registers that tool there, on a connection it keeps open for the step: the sandbox grants
//  the wrapper only the registered agent's tool, and keeps that grant for the attempt once the connection closes. A
//  runtime registers again after its own reattach, since a restarted sandbox runtime does not remember the registration.
//

/** An outer handle that names an attempt socket; the sandbox's carries its place too, which only the sandbox reads. */
const OuterHandleSchema = z.object({ socket: z.string().min(1) });

/** The attempt socket `outer` names, or none when it is a plain handle. */
function socketOf(outer: string): string | undefined {
  try {
    const parsed = OuterHandleSchema.safeParse(JSON.parse(outer));

    return parsed.success ? parsed.data.socket : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registers `agent`'s tool, or with null an app's tool that has no agent id, on the attempt socket `outer` names: the
 * connection it was sent on, which `close` ends, or why there is none. It keeps no process alive on its own.
 */
export function registerThrough({ outer, agent }: { outer: string; agent: string | null }): Promise<{ ok: true; close(): void } | { ok: false; why: string }> {
  const socket = socketOf(outer);

  if (socket === undefined) return Promise.resolve({ ok: false, why: 'its handle names no attempt socket' });

  return new Promise((resolve) => {
    const client = net.connect(socket);

    client.once('error', (error) => {
      client.destroy();
      resolve({ ok: false, why: error.message });
    });
    client.once('connect', () => {
      // A later error, such as the sandbox runtime exiting, ends the registration with it.
      client.on('error', () => client.destroy());
      // The sandbox answers {"connected":…} once it granted the tool, which nothing here waits for.
      client.resume();
      client.unref();
      client.write(`${JSON.stringify({ register: { agent } })}\n`);
      resolve({ ok: true, close: () => { client.end(); } });
    });
  });
}
