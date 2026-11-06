import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeMessage } from '@teamai/runtime-protocol';
import { getUserHome } from '@teamai/tool-core/home';
import { z } from 'zod';
import { attendedSignIn, signInOf, signInSilently, unattendedAuth, validToken } from './auth.js';
import { journal } from './journal.js';
import { serve, type ServeOptions } from './runtime.js';
import { connectT3 } from './t3.js';
import { t3Command, t3HomeOf, t3UserHomeOf } from './t3-command.js';

// teamai-runtime-t3: teamai spawns it for a driver definition that uses runtime `t3` (`--driver t3`), and speaks
// runtime protocol 1 to it over stdio. Its stdout carries only protocol lines, a line for the person as a `notice`;
// stderr carries what only helps to debug it.

// When teamai is gone, a line it would have read goes nowhere: a thread still running keeps going and records its end.
// So does a note on stderr, which the runtime writes for a dropped line or a thread it could not stop.
let stdoutOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

process.stderr.on('error', () => {});

const state = path.join(getUserHome(), '.teamai', 'runtime-state', 't3');

/** T3 Code's data directory on this machine, where its server says where it listens. */
const t3Home = t3HomeOf(process.env, getUserHome());

const t3Cli = t3Command(process.env, t3Home);

/** How long T3 Code's server gets to answer at all before the run counts it as not running. */
const REACH_MS = 3_000;

/** The MCP endpoint of the T3 Code server on this machine, from the file the server writes while it runs. */
function localEndpoint(): URL | undefined {
  try {
    const { origin } = z.object({ origin: z.string().url() }).parse(JSON.parse(fs.readFileSync(path.join(t3Home, 'userdata', 'server-runtime.json'), 'utf8')));

    return new URL('/mcp', origin);
  } catch {
    return undefined;
  }
}

const write = (message: RuntimeMessage): void => {
  if (stdoutOpen) process.stdout.write(`${JSON.stringify(message)}\n`);
};

const connect: ServeOptions['connect'] = async (how) => {
  const resource = localEndpoint();

  if (!resource) return { ok: false, error: { code: 't3_unavailable', message: 'T3 Code is not running on this machine. Open T3 Code, or run `t3 serve`, then start the workflow again.' } };

  // A server file outlives a server that crashed, or one that is stopping: any answer at all means it listens.
  try {
    await fetch(resource, { method: 'HEAD', signal: AbortSignal.timeout(REACH_MS) });
  } catch {
    return { ok: false, error: { code: 't3_unavailable', message: `T3 Code at ${resource.origin} does not answer. Open T3 Code, or run \`t3 serve\`, then start the workflow again.` } };
  }

  const silent = how.mode !== 'recover' && !validToken(state, resource.href) ? await signInSilently({ stateDir: state, resource, t3Home, t3Cli }) : undefined;
  const silentFailure = silent?.ok === false ? silent.reason : undefined;

  if (how.mode !== 'attended' && !validToken(state, resource.href)) {
    const message = silentFailure === undefined
      ? `teamai has no valid T3 Code sign-in for ${resource.origin}, and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.`
      : `teamai has no valid T3 Code sign-in for ${resource.origin} and could not sign in through the t3 command (${silentFailure}), and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.`;

    return { ok: false, error: { code: 'login_required', message } };
  }

  const signIn = how.mode === 'attended' ? await attendedSignIn({ stateDir: state, resource: resource.href, silentFailure, say: (message) => write({ event: 'notice', message }) }) : undefined;

  try {
    const t3 = await connectT3(resource, signIn?.provider ?? unattendedAuth(state, resource.href), () => signIn?.code() ?? Promise.reject(new Error('No sign-in.')));
    const signedInAs = signInOf(state, resource.href);

    if (signedInAs === undefined) {
      await t3.close();

      return { ok: false, error: { code: 't3_unavailable', message: `teamai connected to T3 Code at ${resource.origin} but kept no sign-in for it. Start the workflow again.` } };
    }

    return { ok: true, t3, signIn: signedInAs };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, error: { code: 't3_unavailable', message: `Could not connect to T3 Code at ${resource.origin} (${detail.replace(/\.$/, '')}). Open T3 Code, or run \`t3 serve\`, then start the workflow again.` } };
  } finally {
    signIn?.close();
  }
};

const startedFrom = process.env['T3CODE_THREAD_ID'];

await serve({
  input: process.stdin,
  write,
  journal: journal(path.join(state, 'places')),
  connect,
  t3Home,
  t3UserHome: t3UserHomeOf(t3Home, getUserHome()),
  t3Cli,
  cwd: process.cwd(),
  ...(startedFrom && { startedFrom }),
});

process.exit(0);
