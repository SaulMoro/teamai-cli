/**
 * `reap`: the Vercel sandboxes teamai made that are still alive on the account whose key is present, judged as the
 * ledger judges a leftover, and deleted on `--delete` when they are a world's own or named on the command line. The
 * ledger never asks a remote service; this does.
 */
import { VERCEL_AUTH_KEYS } from '../../packages/runtime-sandbox/src/options.js';
import { z } from 'zod';
import { attributeLeftover, tiesOnThisMachine, type Attribution, type WorldTies } from './leftovers.js';
import { journalOfSbxName } from './leftovers/sbx.js';
import type { World } from './world.js';

/** `reap [<run>] [--delete] [vercel:<name>…]`. */
export function parseReapArgs(args: readonly string[]): { ok: true; run: string | undefined; isDeleting: boolean; named: string[] } | { ok: false; message: string } {
  let run: string | undefined;
  const named: string[] = [];
  let isDeleting = false;

  for (const arg of args) {
    if (arg === '--delete') isDeleting = true;
    else if (arg.startsWith('vercel:') && arg.length > 'vercel:'.length) named.push(arg.slice('vercel:'.length));
    else if (run === undefined && /^\d{8}T\d{6}-[0-9a-f]{6}$/.test(arg)) run = arg;
    else return { ok: false, message: `reap takes a run id, --delete and vercel:<name> words; ${arg} is none of them.` };
  }

  return { ok: true, run, isDeleting, named };
}

/** The Vercel sign-in `env` holds, as the sandbox runtime reads it, or the variables to set. */
export function vercelSignIn(env: NodeJS.ProcessEnv): { ok: true; credentials: { token?: string; teamId?: string; projectId?: string } } | { ok: false; missing: string } {
  const [token, teamId, projectId, oidc] = VERCEL_AUTH_KEYS.map((name) => env[name]);

  if (token && teamId && projectId) return { ok: true, credentials: { token, teamId, projectId } };

  // The SDK reads an OIDC token from this process's environment itself.
  if (oidc) return { ok: true, credentials: {} };

  return { ok: false, missing: `${VERCEL_AUTH_KEYS.slice(0, 2).join(', ')} and ${VERCEL_AUTH_KEYS[2] ?? ''}, or ${VERCEL_AUTH_KEYS[3] ?? ''}` };
}

const ListedSchema = z.array(z.looseObject({ name: z.string(), status: z.string().optional(), tags: z.record(z.string(), z.string()).optional() }));

/** A sandbox that may still run, and bill: anything Vercel does not list as ended. */
const ENDED = new Set(['stopped', 'failed', 'aborted']);

const NO_WORLD: WorldTies = { runId: '', paths: [], journals: [], runs: [] };

/** Each teamai sandbox listed (by a name teamai gives, or named here), whose it is, whether it is alive and whether reap may delete it. */
export function judgeRemote({ listed, self, others, named }: { listed: unknown; self: WorldTies | undefined; others: readonly WorldTies[]; named: readonly string[] }) {
  return ListedSchema.parse(listed).flatMap((sandbox) => {
    const journal = journalOfSbxName(sandbox.name);
    const run = sandbox.tags?.['teamai-run'];
    const isNamed = named.includes(sandbox.name);

    if (journal === undefined && !isNamed) return [];
    const attribution: Attribution = attributeLeftover({ paths: [], journals: journal === undefined ? [] : [journal], runs: run === undefined ? [] : [run], marked: journal !== undefined }, self ?? NO_WORLD, others);

    return [{ name: sandbox.name, attribution, isAlive: !ENDED.has(sandbox.status ?? ''), isDeletable: isNamed || attribution.kind === 'own' }];
  });
}

/** Runs reap; answers its exit code: 1 while a sandbox of the world, or named, is alive. */
export async function reap(args: readonly string[], loadWorld: (run: string) => World): Promise<number> {
  const parsed = parseReapArgs(args);

  if (!parsed.ok) {
    console.error(parsed.message);

    return 1;
  }

  const signIn = vercelSignIn(process.env);

  if (!signIn.ok) {
    console.log(`UNVERIFIABLE: no Vercel key here, so no remote sandbox was listed. Set ${signIn.missing}, then run reap again.`);

    return 0;
  }

  const { Sandbox } = await import('@vercel/sandbox');
  const { self, others } = await tiesOnThisMachine(parsed.run === undefined ? undefined : loadWorld(parsed.run));
  const list = async () => judgeRemote({ listed: await (await Sandbox.list({ namePrefix: 'teamai-', ...signIn.credentials })).toArray(), self, others, named: parsed.named });
  let found = await list();

  if (parsed.isDeleting) {
    for (const sandbox of found.filter((one) => one.isDeletable && one.isAlive)) {
      try {
        await (await Sandbox.get({ name: sandbox.name, ...signIn.credentials })).delete();
        console.log(`Deleted vercel:${sandbox.name}`);
      } catch (error) {
        console.error(`Could not delete vercel:${sandbox.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    found = await list();
  }

  for (const sandbox of found) {
    const whose = sandbox.attribution.kind === 'own' ? "this world's" : sandbox.attribution.kind === 'other_world' ? `world ${sandbox.attribution.runId}'s` : sandbox.attribution.kind === 'ambiguous' ? 'teamai\'s, tied to no world here' : 'named here';
    console.log(`${sandbox.isAlive ? 'ALIVE' : 'ended'} vercel:${sandbox.name} (${whose})`);
  }

  return found.some((one) => one.isAlive && one.isDeletable) ? 1 : 0;
}
