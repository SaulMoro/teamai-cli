import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeMessage } from '@teamai/runtime-protocol';
import { getUserHome } from '@teamai/tool-core/home';
import { z } from 'zod';
import { attendedSignIn, unattendedAuth, validToken } from './auth.js';
import { journal } from './journal.js';
import { serve, type ServeOptions } from './runtime.js';
import { connectT3 } from './t3.js';

// teamai-runtime-t3: teamai spawns it for a driver definition that uses runtime `t3` (`--driver t3`), and speaks
// runtime protocol 1 to it over stdio. Its stdout carries only protocol lines; anything for a person goes to stderr.

let stdoutOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

const state = path.join(getUserHome(), '.teamai', 'runtime-state', 't3');

/** The MCP endpoint of the T3 Code server on this machine, from the file the server writes while it runs. */
function localEndpoint(): URL | undefined {
  const t3Home = process.env['T3CODE_HOME'] || path.join(getUserHome(), '.t3');

  try {
    const { origin } = z.object({ origin: z.string().url() }).parse(JSON.parse(fs.readFileSync(path.join(t3Home, 'userdata', 'server-runtime.json'), 'utf8')));

    return new URL('/mcp', origin);
  } catch {
    return undefined;
  }
}

const connect: ServeOptions['connect'] = async (mode) => {
  const resource = localEndpoint();

  if (!resource) return { ok: false, error: { code: 't3_unavailable', message: 'T3 Code is not running on this machine. Open T3 Code, then start the workflow again.' } };

  if (mode === 'unattended' && !validToken(state, resource.href)) {
    return {
      ok: false,
      error: {
        code: 'login_required',
        message: `teamai has no valid T3 Code sign-in for ${resource.origin}, and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.`,
      },
    };
  }

  const signIn = mode === 'attended' ? await attendedSignIn(state, resource.href) : undefined;

  try {
    const t3 = await connectT3(resource, signIn?.provider ?? unattendedAuth(state, resource.href), () => signIn?.code() ?? Promise.reject(new Error('No sign-in.')));

    return { ok: true, t3 };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, error: { code: 't3_unavailable', message: `Could not connect to T3 Code at ${resource.origin}: ${detail}` } };
  } finally {
    signIn?.close();
  }
};

const startedFrom = process.env['T3CODE_THREAD_ID'];

await serve({
  input: process.stdin,
  write: (message: RuntimeMessage) => {
    if (stdoutOpen) process.stdout.write(`${JSON.stringify(message)}\n`);
  },
  journal: journal(path.join(state, 'places')),
  connect,
  ...(startedFrom && { startedFrom }),
});

process.exit(0);
