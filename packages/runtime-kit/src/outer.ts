import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';

// ─── The outer runtime a place runs through ──────────────
//
//  When a step runs `through: sandbox`, teamai opens the place in the sandbox runtime first and gives its handle to the
//  app's runtime (the inner one) as `outer`. The app launches teamai's wrapper in place of the tool, and the wrapper
//  asks the sandbox, over the attempt's socket, how to start the tool. The inner runtime registers on that socket the
//  agent it is about to start, so the sandbox serves that agent's wrapper and no other, and says once it connected:
//
//    inner  > {"register":{"agent":"<id>"}}    < {"connected":{"agent":"<id>"}}   once the sandbox granted its wrapper
//
//  The latest registration wins, and the connection stays open while the inner follows the agent. A registration that
//  ends (the inner runtime stopped) is made again by the runtime that reattaches.
//

/** The handle of a place whose attempt socket serves the wrapper: the place, and the socket the inner registers on. */
export const OuterHandleSchema = z.object({ place: z.string().min(1), socket: z.string().min(1) });

export type OuterHandle = z.infer<typeof OuterHandleSchema>;

const ConnectedSchema = z.object({ connected: z.object({ agent: z.string().min(1).nullable() }) });

/** The attempt socket `outer` names, when it is the handle of a place that runs through a sandbox. */
export function outerHandleOf(outer: string): OuterHandle | undefined {
  try {
    const parsed = OuterHandleSchema.safeParse(JSON.parse(outer));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface Registration {
  /** Settles once the sandbox says the agent's wrapper connected, or with why it never can on this connection. */
  connected: Promise<{ ok: true } | { ok: false; why: string }>;
  /** Ends the registration; the sandbox then serves no wrapper of this agent until one registers it again. */
  close(): void;
}

/**
 * Registers `agent` on the attempt socket at `socketPath`. Never on a socket in a directory another user may open: who
 * made that socket would say what ran in the sandbox.
 */
export function registerAgent(socketPath: string, agent: string): Registration {
  const dir = path.dirname(socketPath);

  const stat = (() => {
    try {
      return fs.lstatSync(dir);
    } catch {
      return undefined;
    }
  })();

  if (stat === undefined || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    return { connected: Promise.resolve({ ok: false, why: `${dir} is not a directory of this user's that only this user may open (0700)` }), close: () => {} };
  }

  const client = net.connect(socketPath);

  const connected = new Promise<{ ok: true } | { ok: false; why: string }>((resolve) => {
    const lines = readline.createInterface({ input: client });
    // readline re-emits the socket's errors on the interface, which throws them when nothing listens there.
    lines.on('error', (error) => resolve({ ok: false, why: `the attempt socket ${socketPath} does not answer: ${error.message}` }));
    client.on('close', () => resolve({ ok: false, why: `the attempt socket ${socketPath} closed the registration before the wrapper connected` }));
    client.on('connect', () => client.write(`${JSON.stringify({ register: { agent } })}\n`));
    lines.on('line', (line) => {
      try {
        if (ConnectedSchema.parse(JSON.parse(line)).connected.agent === agent) resolve({ ok: true });
      } catch {
        // A line of another version's, or a refusal: the wait for this agent's connection goes on until the socket closes.
      }
    });
  });

  client.unref();

  return { connected, close: () => client.destroy() };
}
