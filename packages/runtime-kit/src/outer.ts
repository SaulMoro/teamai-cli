import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';

// ─── A place through an outer runtime ───
//
//  An app's runtime (T3 Code, Paseo) whose entry runs through a sandbox (`use: t3, through: sandbox`) gets the outer's
//  handle as `open.outer`: JSON with the attempt socket the sandbox serves its wrapper on. Before the app starts the
//  step's tool, the runtime registers that tool there, on a connection it keeps open for the step: the sandbox grants
//  the wrapper only the registered agent's tool, and says on that connection once it did:
//
//    inner  > {"register":{"agent":"<id>"|null}}    < {"connected":{"agent":"<id>"|null}}   once it granted the wrapper
//
//  A runtime registers again after its own reattach, since a restarted sandbox runtime does not remember the
//  registration.
//

/** An outer handle that names an attempt socket; the sandbox's carries its place too, which only the sandbox reads. */
const OuterHandleSchema = z.object({ socket: z.string().min(1) });

const ConnectedSchema = z.object({ connected: z.object({ agent: z.string().min(1).nullable() }) });

/** The attempt socket `outer` names, or none when it is a plain handle, as one of a sandbox that serves no socket. */
export function socketOf(outer: string): string | undefined {
  try {
    const parsed = OuterHandleSchema.safeParse(JSON.parse(outer));

    return parsed.success ? parsed.data.socket : undefined;
  } catch {
    return undefined;
  }
}

/** Why `socket` is not one to register on: one in a directory another user may open would say what ran in the sandbox. */
function unsafeDirOf(socket: string): string | undefined {
  const dir = path.dirname(socket);

  const stat = (() => {
    try {
      return fs.lstatSync(dir);
    } catch {
      return undefined;
    }
  })();

  // A missing directory is a socket nothing serves, which the connection says.
  if (stat === undefined) return undefined;

  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 ? undefined : `${dir} is not a directory of this user's that only this user may open (0700)`;
}

export interface Registration {
  ok: true;
  /** Ends the registration's connection. */
  close(): void;
  /** Settles once the sandbox says the registered agent's wrapper connected, or with why it never can on this connection. */
  connected: Promise<{ ok: true } | { ok: false; why: string }>;
}

/**
 * Registers `agent`'s tool, or with null an app's tool that has no agent id, on the attempt socket `outer` names: the
 * connection it was sent on, which `close` ends, or why there is none. It keeps no process alive on its own.
 */
export function registerThrough({ outer, agent }: { outer: string; agent: string | null }): Promise<Registration | { ok: false; why: string }> {
  const socket = socketOf(outer);

  if (socket === undefined) return Promise.resolve({ ok: false, why: 'its handle names no attempt socket' });
  const unsafe = unsafeDirOf(socket);

  if (unsafe !== undefined) return Promise.resolve({ ok: false, why: unsafe });

  return new Promise((resolve) => {
    const client = net.connect(socket);

    let settle = (_connected: { ok: true } | { ok: false; why: string }): void => {};
    const connected = new Promise<{ ok: true } | { ok: false; why: string }>((resolveConnected) => { settle = resolveConnected; });
    const lines = readline.createInterface({ input: client });

    // readline re-emits the socket's errors on the interface, which throws them when nothing listens there.
    lines.on('error', (error) => {
      client.destroy();
      resolve({ ok: false, why: error.message });
      settle({ ok: false, why: `the attempt socket ${socket} failed: ${error.message}` });
    });

    lines.on('line', (line) => {
      try {
        if (ConnectedSchema.parse(JSON.parse(line)).connected.agent === agent) settle({ ok: true });
      } catch {
        // A line of another version's: the wait for this agent's connection goes on until the socket closes.
      }
    });

    client.on('close', () => settle({ ok: false, why: `the attempt socket ${socket} closed the registration before the wrapper connected` }));

    client.once('connect', () => {
      client.unref();
      client.write(`${JSON.stringify({ register: { agent } })}\n`);
      resolve({ ok: true, close: () => { client.end(); }, connected });
    });
  });
}
