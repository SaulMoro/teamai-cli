import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Can, RuntimeFailure } from '@teamai/runtime-protocol';
import type { JournalId } from '../journal.js';
import { COMMAND_MS, type ExecEnd, type PlaceKey, type Provider } from '../provider.js';
import { offerSignedIn } from '../sign-in.js';
import { cliOf, LAUNCHABLE, mountsOf, WORKSPACES, type Ran } from './cli.js';

// ─── sbx (Docker Sandboxes) ──────────────────────────────
//
//  One microVM per attempt, from the agent's template, each place path at its host path through virtiofs:
//
//    sbx create --name teamai-<journal>-<run>-<attempt> --no-progress <template> <worktree> <result> <run dir> <tool home> <git path>:ro …
//    sbx exec -w <cwd> -e NAME … teamai-<journal>-<run>-<attempt> env -u WITHHELD … -- <argv>
//    sbx stop teamai-<journal>-<run>-<attempt>          ends every process; the next exec starts the sandbox again
//    sbx rm --force teamai-<journal>-<run>-<attempt>
//
//  The worktree is the primary workspace. sbx does not follow a linked worktree's `.git` to its common directory, so
//  the git paths the view names are mounted read-only at their own paths: `git status` works, `git commit` cannot
//  write. No credential goes in at create: each exec brings its own, by name, from this process's environment. A
//  login stored with `sbx secret set` stays in the host's proxy, which injects it into the requests; the sandbox holds
//  only the placeholder variables its agent reads, which an exec keeps unless teamai withholds them. The name is its
//  id: `sbx ls` finds it again after a restart. A sandbox carries no label (sbx 0.50.1 `create` takes none), so
//  its name carries the journal that owns it, the id a container's `teamai.owner` label carries, and an open sweeps the
//  sandboxes `sbx ls` lists under this journal's prefix as it sweeps containers by their label. sbx's network policy
//  lets a sandbox reach every host it allows, so this provider offers no judge, which must reach its model provider only.
//

/**
 * The agent template sbx ships for each tool teamai launches, when it ships one. With no `agent`, an attempt starts
 * from its own tool's, and a command step's from the bare `shell` template, which holds no agent.
 */
const TEMPLATE_OF = { claude: 'claude', codex: 'codex', codebuddy: undefined } satisfies Record<(typeof LAUNCHABLE)[number], string | undefined>;

/** The tools sbx ships a template for, which a sandbox with no `agent` offers. */
const TEMPLATED = LAUNCHABLE.filter((tool) => TEMPLATE_OF[tool] !== undefined);

const NOT_INSTALLED = 'sbx is not installed here, or not on PATH. Install Docker Sandboxes (https://docs.docker.com/ai/sandboxes/), sign in with `sbx login`, and start again.';

/**
 * sbx's own settings, which it reads from its environment: an exec's names never replace them, so a step cannot point
 * the CLI at another home, daemon or proxy, and are never passed into the sandbox.
 */
const CLI_SETTING = /^(?:HOME|XDG_[A-Z_]+|SBX_[A-Z0-9_]*|DOCKER_[A-Z0-9_]*)$/;

const ListedSchema = z.array(z.looseObject({ name: z.string() }));

/** `sbx policy check network --json <target>`: whether the member's policy lets a sandbox reach it (sbx 0.51.0). */
const CheckedSchema = z.object({ allowed: z.boolean() });

/** `sbx secret ls --global --json`: the services sbx's proxy holds a login for. Each secret's masked value is never read. */
const StoredSchema = z.object({ secrets: z.array(z.object({ name: z.string() })) });

/**
 * Where an agent template keeps a tool's sign-in in its own home, by the variable that moves the tool's home: the
 * stand-in sbx's proxy swaps for the stored login (sbx 0.51.0's claude template: `~/.claude/.credentials.json`). teamai
 * points that variable at the attempt's tool home, where the tool would find no sign-in, so the sandbox links it there.
 * Codex's template keeps none: it signs in from an OPENAI_API_KEY placeholder in its env.
 */
const TEMPLATE_SIGN_IN = { CLAUDE_CONFIG_DIR: '.claude/.credentials.json' } satisfies Record<string, string>;

/** The notice sbx prints on stderr when an exec starts a sandbox it stopped while idle: sbx's line, not the step's. */
const STARTED = /^[ \t]*✓ sandbox \S+ — started\r?\n/;

/** The sandbox names `sbx ls --json` printed, or undefined when it printed something else. */
function namesListed(stdout: string): string[] | undefined {
  try {
    const listed = ListedSchema.safeParse(JSON.parse(stdout));

    return listed.success ? listed.data.map(({ name }) => name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `owner`: the id of the journal whose attempts the sandboxes are, which starts each one's name. `agent`: the template
 * or kit every sandbox starts from; unset, each attempt's tool picks its template.
 */
export function sbxProvider({ agent, owner, env }: { agent: string | undefined; owner: JournalId; env: NodeJS.ProcessEnv }): Provider {
  const { run: cli } = cliOf({ name: 'sbx', env, notInstalled: NOT_INSTALLED });

  /** What starts the name of every sandbox of this journal. */
  const journalPrefix = `teamai-${owner}-`;

  /** An attempt's sandbox name, which is also its id: `teamai-<journal>-<run>-<attempt>`. */
  const nameOf = ({ run, attempt }: PlaceKey): string => `${journalPrefix}${run}-${attempt}`;

  /** What sbx said: its `error: …` line and the `try: …` hint it adds, on one line. */
  const messageOf = (ran: Ran): string => (ran.kind !== 'ran' ? ran.message : ran.stderr.trim().split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('✓')).slice(-2).join('; '));

  const unavailable = (message: string) => ({ ok: false, failure: { code: 'sandbox_unavailable', message } }) satisfies { ok: false; failure: RuntimeFailure };

  /** Every sandbox name `sbx ls --json` lists, within COMMAND_MS, or what sbx said instead. */
  const list = async (): Promise<{ ok: true; names: string[] } | { ok: false; message: string }> => {
    const ran = await cli(['ls', '--json'], { timeoutMs: COMMAND_MS });
    const names = ran.kind === 'ran' && ran.code === 0 ? namesListed(ran.stdout) : undefined;

    return names !== undefined ? { ok: true, names } : { ok: false, message: messageOf(ran) || 'it printed no list' };
  };

  const find: Provider['find'] = async (key) => {
    const listed = await list();
    const name = nameOf(key);

    if (listed.ok) return { ok: true, id: listed.names.includes(name) ? name : undefined };

    return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not list its sandboxes: ${listed.message}. Sandbox ${name} stays this attempt's until sbx answers again (\`sbx daemon start\`); to remove it now, run \`sbx rm --force ${name}\`.` } };
  };

  const remove = async (name: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const removed = await cli(['rm', '--force', name], { timeoutMs: COMMAND_MS });

    if (removed.kind === 'ran' && (removed.code === 0 || /not found/i.test(removed.stderr))) return { ok: true };

    return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not remove sandbox ${name}: ${messageOf(removed)}. Remove it with \`sbx rm --force ${name}\`.` } };
  };

  /** The tools a kit (or an agent other than claude and codex) brings, from a scratch sandbox with no workspace. */
  const probeTools = async (kit: string): Promise<{ ok: true; tools: string[] } | { ok: false; failure: RuntimeFailure }> => {
    const scratch = `teamai-tools-${crypto.randomBytes(4).toString('hex')}`;
    const created = await cli(['create', '--name', scratch, '--no-progress', kit]);

    if (created.kind !== 'ran' || created.code !== 0) return unavailable(`sbx could not create a sandbox from agent ${kit} (${messageOf(created)}). Check the agent name or kit reference, and start again.`);
    const probe = await cli(['exec', scratch, '/bin/sh', '-c', `for t in ${LAUNCHABLE.join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; exit 0`]);
    const removed = await remove(scratch);

    if (!removed.ok) return { ok: false, failure: { code: 'sandbox_unavailable', message: removed.failure.message } };

    if (probe.kind !== 'ran' || probe.code !== 0) return unavailable(`sbx could not run a command in a sandbox from agent ${kit} (${messageOf(probe)}). Check that its template runs /bin/sh, and start again.`);
    const found = new Set(probe.stdout.split('\n').map((line) => line.trim()));

    return { ok: true, tools: LAUNCHABLE.filter((tool) => found.has(tool)) };
  };

  /**
   * Links, inside sandbox `name`, the sign-in its template keeps for each tool whose home the attempt moves into its
   * tool home, unless that home already holds one. Only a link lands on the host's disk, pointing into the sandbox.
   */
  const linkSignIns = async (name: string, toolHome: Record<string, string>): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const links = Object.entries(toolHome).flatMap(([variable, dir]) => {
      const file = Object.entries(TEMPLATE_SIGN_IN).find(([home]) => home === variable)?.[1];

      return file === undefined ? [] : [file, dir];
    });

    if (links.length === 0) return { ok: true };
    const script = 'while [ $# -gt 0 ]; do f="$HOME/$1" t="$2/$(basename "$1")"; if [ -e "$f" ] && [ ! -e "$t" ] && [ ! -L "$t" ]; then ln -s "$f" "$t" || exit 1; fi; shift 2; done';
    const ran = await cli(['exec', name, '/bin/sh', '-c', script, 'sh', ...links], { timeoutMs: COMMAND_MS });

    if (ran.kind === 'ran' && ran.code === 0) return { ok: true };

    return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not give the tool in sandbox ${name} the login sbx keeps for it: ${messageOf(ran) || 'the link failed'}. Remove it with \`sbx rm --force ${name}\`, and start again.` } };
  };

  /** The services whose login sbx's proxy holds for every sandbox, which it injects into a tool's requests. */
  const storedLogins = async (): Promise<{ ok: true; services: ReadonlySet<string> } | { ok: false; failure: RuntimeFailure }> => {
    const ran = await cli(['secret', 'ls', '--global', '--json']);
    let parsed: z.infer<typeof StoredSchema> | undefined;

    try {
      parsed = ran.kind === 'ran' && ran.code === 0 ? StoredSchema.parse(JSON.parse(ran.stdout)) : undefined;
    } catch {
      parsed = undefined;
    }

    if (parsed === undefined) return unavailable(`sbx could not list the logins it keeps (${messageOf(ran) || 'it printed no list'}). Run \`sbx secret ls\` to see why, and start again.`);

    return { ok: true, services: new Set(parsed.secrets.map(({ name }) => name)) };
  };

  return {
    async offer(credentials) {
      const ls = await cli(['ls', '--json']);

      if (ls.kind !== 'ran') return unavailable(ls.message);

      if (ls.code !== 0) return unavailable(`sbx cannot reach its daemon (${messageOf(ls)}). Run \`sbx daemon start\`, or \`sbx login\` if you are signed out, and start again.`);
      const policy = await cli(['policy', 'ls']);

      if (policy.kind === 'ran' && /not been initialized/i.test(policy.stderr)) {
        return unavailable('sbx creates no sandbox until its network policy is set. Run `sbx policy init balanced` once (or `sbx policy init deny-all` and allow your model provider with `sbx policy allow network <host>`), and start again.');
      }

      const found = agent === undefined ? { ok: true as const, tools: [...TEMPLATED] } : LAUNCHABLE.some((tool) => tool === agent) ? { ok: true as const, tools: [agent] } : await probeTools(agent);

      if (!found.ok) return found;
      const stored = await storedLogins();

      if (!stored.ok) return stored;
      const { tools, unavailable: notSignedIn, kept, unusedGateways } = offerSignedIn({ tools: found.tools, provider: 'sbx', credentials, stored: stored.services, env });
      const can: Can = { workspace: WORKSPACES, isolation: 'sandbox', env: true, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true };

      // sbx's proxy answers host.docker.internal as this machine's localhost, which its policy then allows or refuses.
      return { ok: true, can, host: { ok: true, alias: 'host.docker.internal' }, unavailable: notSignedIn, ownLogins: kept, unusedGateways };
    },

    find,

    async reachesHost(port, variable) {
      const rule = `\`sbx policy allow network localhost:${port}\``;
      const ran = await cli(['policy', 'check', 'network', '--json', `localhost:${port}`], { timeoutMs: COMMAND_MS });
      let checked: z.infer<typeof CheckedSchema> | undefined;

      try {
        checked = ran.kind === 'ran' ? CheckedSchema.parse(JSON.parse(ran.stdout)) : undefined;
      } catch {
        checked = undefined;
      }

      if (checked?.allowed === true) return { ok: true };

      if (checked?.allowed === false) return unavailable(`${variable} points at port ${port} of this machine, which your sbx network policy does not let a sandbox reach. Allow it once with ${rule}, and start again.`);

      return unavailable(`sbx could not tell whether your network policy lets a sandbox reach port ${port} of this machine, which ${variable} points at (${messageOf(ran) || 'it printed no answer'}). If it does not, allow it with ${rule}, and start again.`);
    },

    async owned() {
      const listed = await list();

      if (!listed.ok) return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not list the sandboxes this runtime's journal owns: ${listed.message}` } };

      return {
        ok: true,
        sandboxes: listed.names.flatMap((name) => {
          const [run, attempt, ...more] = name.startsWith(journalPrefix) ? name.slice(journalPrefix.length).split('-') : [];

          return run && attempt && more.length === 0 ? [{ id: name, run, attempt }] : [];
        }),
      };
    },

    async create(key, view, tool) {
      const launched = LAUNCHABLE.find((each) => each === tool);
      const template = agent ?? (tool === undefined ? 'shell' : launched && TEMPLATE_OF[launched]);

      if (template === undefined) {
        return { ok: false, failure: { code: 'bad_option', key: 'agent', message: `sbx ships no template for ${tool}, the tool of attempt ${key.attempt}. Set agent to a kit reference that brings ${tool}, or run the step on claude or codex` } };
      }

      const mounted = mountsOf('sbx', view);

      if (!mounted.ok) return mounted;
      const name = nameOf(key);
      // mountsOf lists the worktree first, which sbx takes as the primary workspace.
      const paths = mounted.mounts.map(({ at, mode }) => (mode === 'ro' ? `${at}:ro` : at));
      const created = await cli(['create', '--name', name, '--no-progress', template, ...paths]);

      if (created.kind === 'ran' && created.code === 0) {
        const linked = await linkSignIns(name, view.toolHome);

        return linked.ok ? { ok: true, id: name } : linked;
      }

      // Another open of the same attempt created it first: that sandbox is this attempt's.
      const raced = await find(key);

      if (raced.ok && raced.id !== undefined) return { ok: true, id: name };

      return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not create the sandbox for attempt ${key.attempt} from agent ${template}: ${messageOf(created)}` } };
    },

    async exec(id, spec, onOutput): Promise<ExecEnd> {
      const passed = Object.keys(spec.env).filter((variable) => !CLI_SETTING.test(variable));
      const cliEnv: NodeJS.ProcessEnv = { ...env, ...Object.fromEntries(passed.map((variable) => [variable, spec.env[variable]])) };
      const withheld = spec.unset.length > 0 ? ['env', ...spec.unset.flatMap((variable) => ['-u', variable]), '--'] : [];
      let isFirstChunk = true;

      // A sandbox sbx stopped while idle starts again first, with sbx's own notice before the step's stderr.
      const ran = await cli(['exec', '-w', spec.cwd, ...passed.flatMap((variable) => ['-e', variable]), id, ...withheld, ...spec.argv], {
        env: cliEnv,
        onOutput: (stream, data) => {
          const own = isFirstChunk && stream === 'stderr' ? data.replace(STARTED, '') : data;
          isFirstChunk = false;

          if (own !== '') onOutput(stream, own);
        },
      });

      return ran.kind === 'ran' ? { kind: 'exited', code: ran.code } : { kind: 'failed', failure: { code: 'exec_failed', message: ran.message } };
    },

    async stop(id) {
      const stopped = await cli(['stop', id], { timeoutMs: COMMAND_MS });

      if (stopped.kind === 'ran' && stopped.code === 0) return { ok: true };

      return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not stop sandbox ${id}: ${messageOf(stopped)}. What runs there may still run; remove it with \`sbx rm --force ${id}\`.` } };
    },

    destroy: remove,

    display: (key) => ({ label: `${nameOf(key)} (sbx)`, fields: { sandbox: nameOf(key), ...(agent !== undefined && { agent: path.basename(agent) }) } }),

    removal: (place) => `remove it with \`sbx rm --force ${nameOf(place)}\``,
  };
}
