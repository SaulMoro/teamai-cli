/**
 * Watches the sandboxes a world's command makes while it runs, and judges each one's environment with
 * `judgeSandboxEnv`: containers and sbx sandboxes tied to the world, and on Linux each bwrap whose arguments name a world
 * path. Values are read and compared in memory only; what is written (observed.jsonl, the `[verify] observed` lines)
 * holds names. Loaded only once a HOME of the world holds the sandbox runtime's journal.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { collectEnvSecrets } from '@teamai/shared/redact';
import YAML from 'yaml';
import { z } from 'zod';
import { journal, sandboxJournalRoot } from '../../packages/runtime-sandbox/src/journal.js';
import { CONTAINER_ENGINES, PROVIDER_COMMANDS } from '../../packages/runtime-sandbox/src/options.js';
import { journalOfSbxName } from './leftovers/sbx.js';
import { judgeSandboxEnv, parseEnviron, type EnvVerdict } from './secrets.js';
import { CANARY_NAME, type World } from './world.js';

const run = promisify(execFile);
const POLL_MS = 500;

/** Every process's environment inside a sandbox, one block per process, blocks split by an empty entry. Never printed. */
const ENVIRONS = 'for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null && printf "\\0\\0"; done';

/** What one sandbox showed over a command: how many environments were read, and every leaking name among them. */
interface Seen {
  readonly what: string;
  read: number;
  names: Set<string>;
}

/** The HOMEs of the world's installs on this machine's file system: a container member's is mounted at the same path. */
function homesOf(world: World): string[] {
  return [world.home, ...(world.members ?? []).map((member) => member.home)];
}

const DriverCredentialsSchema = z.looseObject({ runtimes: z.array(z.looseObject({ credentials: z.record(z.string(), z.unknown()).optional() })).optional() });

/** The credential names every driver definition in the world declares, by the definitions' own `credentials` keys. */
function declaredCredentials(world: World): Set<string> {
  const declared = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    for (const entry of depth > 8 || !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') walk(full, depth + 1);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name) && full.split(path.sep).includes('drivers')) {
        const parsed = DriverCredentialsSchema.safeParse(YAML.parse(fs.readFileSync(full, 'utf8')));

        for (const runtime of parsed.success ? parsed.data.runtimes ?? [] : []) for (const name of Object.keys(runtime.credentials ?? {})) declared.add(name);
      }
    }
  };

  for (const home of homesOf(world)) walk(path.join(home, '.teamai'), 0);

  return declared;
}

/** Each environment `ENVIRONS` printed. */
function environsOf(stdout: string): Array<Map<string, string>> {
  return stdout.split('\0\0').flatMap((block) => (block === '' ? [] : [parseEnviron(block)]));
}

async function listed(argv: readonly string[]): Promise<string | undefined> {
  const [command = 'true', ...args] = argv;

  try {
    return (await run(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 ** 2 })).stdout;
  } catch {
    return undefined;
  }
}

const SbxListedSchema = z.array(z.looseObject({ name: z.string(), status: z.string().optional() }));

/** Starts watching; `stop` takes a last look and answers the lines to show, and has written them to observed.jsonl. */
export function startObserver(world: World, { pass, label }: { pass: ReadonlyMap<string, string>; label: string }) {
  const canary = world.env?.[CANARY_NAME] ?? '';
  const secrets = new Map([...Object.entries(collectEnvSecrets(process.env)), ...pass]);
  const declared = declaredCredentials(world);
  const owners = new Set<string>(homesOf(world).map((home) => journal(sandboxJournalRoot(home)).owner));
  const seen = new Map<string, Seen>();
  const unobserved = new Set<string>();
  const notRunning = new Map<string, string>();
  let sawSeatbelt = false;
  let enginesUp: Array<(typeof CONTAINER_ENGINES)[number]> | undefined;

  const judge = (key: string, what: string, environs: ReadonlyArray<ReadonlyMap<string, string>>): void => {
    const entry = seen.get(key) ?? { what, read: 0, names: new Set<string>() };
    seen.set(key, entry);

    for (const env of environs) {
      entry.read += 1;
      const verdict: EnvVerdict = judgeSandboxEnv({ env, canary, secrets, declared });

      if (verdict.kind === 'leak') for (const name of verdict.names) entry.names.add(name);
    }
  };

  const containers = async (): Promise<void> => {
    enginesUp ??= (await Promise.all(CONTAINER_ENGINES.map(async (engine) => ((await listed([PROVIDER_COMMANDS[engine], 'info', '--format', '{{.ServerVersion}}'])) === undefined ? [] : [engine])))).flat();

    for (const engine of enginesUp) {
      const command = PROVIDER_COMMANDS[engine];
      const lines = await listed([command, 'ps', '--filter', 'label=teamai.owner', '--format', '{{.ID}}\t{{.Names}}\t{{.Label "teamai.owner"}}']);

      if (lines === undefined) {
        unobserved.add(`${engine} containers, \`${engine} ps\` failed`);
        continue;
      }

      for (const line of lines.split('\n')) {
        const [id = '', name = '', owner = ''] = line.split('\t');

        if (id === '' || !owners.has(owner)) continue;
        const environs = await listed([command, 'exec', id, 'sh', '-c', ENVIRONS]);

        if (environs !== undefined) judge(`${engine}:${name}`, `${engine}:${name}`, environsOf(environs));
      }
    }
  };

  const sbx = async (): Promise<void> => {
    const out = await listed([PROVIDER_COMMANDS.sbx, 'ls', '--json']);
    const parsed = out === undefined ? undefined : SbxListedSchema.safeParse(JSON.parse(out));

    for (const sandbox of parsed?.success === true ? parsed.data : []) {
      const owner = journalOfSbxName(sandbox.name);

      if (owner === undefined || !owners.has(owner)) continue;

      // `sbx exec` starts a stopped sandbox: only one listed as running is asked.
      if (sandbox.status !== 'running') {
        notRunning.set(sandbox.name, sandbox.status ?? 'in no state');
        continue;
      }

      const environs = await listed([PROVIDER_COMMANDS.sbx, 'exec', sandbox.name, 'sh', '-c', ENVIRONS]);

      if (environs !== undefined) judge(`sbx:${sandbox.name}`, `sbx:${sandbox.name}`, environsOf(environs));
    }
  };

  /** On Linux, each bwrap whose arguments name a world path: the environment of its first descendant that is not bwrap. */
  const bwraps = (): void => {
    if (process.platform !== 'linux') return;

    const procs = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        const ppid = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1] ?? '';

        return [{ pid, ppid, args }];
      } catch {
        return [];
      }
    });

    const isBwrap = (args: readonly string[]): boolean => path.basename(args[0] ?? '') === 'bwrap';

    for (const outer of procs.filter((proc) => isBwrap(proc.args) && proc.args.some((arg) => arg.startsWith(world.dir) || arg.startsWith(world.tmp)))) {
      let frontier = [outer.pid];

      while (frontier.length > 0) {
        const children = procs.filter((proc) => frontier.includes(proc.ppid));
        const first = children.filter((proc) => !isBwrap(proc.args));

        if (first.length > 0) {
          for (const proc of first) {
            try {
              judge(`bwrap:${outer.pid}`, `bwrap:${outer.pid}`, [parseEnviron(fs.readFileSync(`/proc/${proc.pid}/environ`, 'utf8'))]);
            } catch {
              unobserved.add(`bwrap:${outer.pid}'s environment, /proc/${proc.pid}/environ could not be read`);
            }
          }

          break;
        }

        frontier = children.map((proc) => proc.pid);
      }
    }
  };

  let polling: Promise<void> | undefined;

  const poll = (): Promise<void> => (polling ??= Promise.all([containers(), sbx()]).then(() => {
    bwraps();
    // A place's record goes once it closes, so each look notes whether one runs on seatbelt.
    sawSeatbelt ||= homesOf(world).some(usesSeatbelt);
  }).finally(() => { polling = undefined; }));

  const timer = setInterval(() => void poll(), POLL_MS);

  return {
    async stop(): Promise<string[]> {
      clearInterval(timer);
      await polling;
      await poll();
      const at = new Date().toISOString();
      const records = [...seen.values()].map((entry) => ({ at, command: label, what: entry.what, read: entry.read, verdict: entry.names.size === 0 ? 'env ok' : 'ENV LEAK', names: [...entry.names].toSorted() }));

      for (const [name, status] of notRunning) if (!seen.has(`sbx:${name}`)) unobserved.add(`sbx:${name}'s environment, sbx listed it as ${status}, and only a running one is asked`);

      if (records.length > 0) fs.appendFileSync(path.join(world.dir, 'observed.jsonl'), records.map((record) => `${JSON.stringify(record)}\n`).join(''));

      return [
        ...records.map((record) => `[verify] observed ${record.what}: ${record.read === 0 ? 'NOT OBSERVED, no environment could be read' : record.names.length === 0 ? 'env ok' : `ENV LEAK ${record.names.join(', ')}`}`),
        ...[...unobserved].map((what) => `[verify] NOT OBSERVED: ${what}`),
        ...(sawSeatbelt ? ['[verify] seatbelt has no observer: the env check proves nothing for a seatbelt step'] : []),
      ];
    },
  };
}

const PlaceOptionsSchema = z.looseObject({ options: z.looseObject({ provider: z.string().optional() }).optional() });

/** Whether a place the sandbox runtime recorded under `home` ran on seatbelt. */
function usesSeatbelt(home: string): boolean {
  const places = path.join(sandboxJournalRoot(home), 'places');

  return (fs.existsSync(places) ? fs.readdirSync(places) : []).some((name) => {
    if (!name.endsWith('.json')) return false;

    try {
      return PlaceOptionsSchema.parse(JSON.parse(fs.readFileSync(path.join(places, name), 'utf8'))).options?.provider === 'seatbelt';
    } catch {
      return false;
    }
  });
}
