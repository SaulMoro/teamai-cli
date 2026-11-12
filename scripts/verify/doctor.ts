/**
 * `doctor --drivers`: what a driver claim needs on this machine, read-only. Each sandbox provider's readiness, the driver
 * host command each step runtime declares, each tool's cheapest model, and the keys present, by name. Loaded only for `--drivers`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { collectEnvSecrets } from '@teamai/shared/redact';
import { PROVIDER_COMMANDS } from '../../packages/runtime-sandbox/src/provider-commands.js';
import { VERCEL_AUTH } from '../../packages/runtime-sandbox/src/providers/vercel.js';
import { priceTokens } from '../../src/token-usage/pricing.js';
import { captureOn } from './target.js';
import { recordWriters, runtimeHostCommands, TOOL_COMMANDS, worldFiles, worldWritersFile, type World } from './world.js';

/** What `argv` printed, or why it could not say: run in the harness's own environment, never a world's. */
function probe(argv: readonly string[]): { ok: true; first: string; stdout: string } | { ok: false; why: string } {
  const [command = 'true', ...args] = argv;
  const ran = spawnSync(command, args, { cwd: os.tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 64 * 1024 ** 2 });

  if (ran.error !== undefined) return { ok: false, why: 'code' in ran.error && ran.error.code === 'ENOENT' ? 'not installed' : ran.error.message };

  if (ran.status !== 0) return { ok: false, why: ran.stderr.trim().split('\n').at(-1) || `exit ${ran.status}` };

  return { ok: true, first: ran.stdout.trim().split('\n')[0] ?? '', stdout: ran.stdout };
}

/** How each provider is asked whether it can run here: a new provider fails the type check until it has a row. */
const PROVIDER_READINESS = {
  docker: () => probe([PROVIDER_COMMANDS.docker, 'info', '--format', 'up, server {{.ServerVersion}}']),
  podman: () => probe([PROVIDER_COMMANDS.podman, 'info', '--format', 'up, server {{.Version.Version}}']),
  sbx: () => probe([PROVIDER_COMMANDS.sbx, 'version']),
  bwrap: () => (process.platform === 'linux' ? probe([PROVIDER_COMMANDS.bwrap, '--version']) : { ok: false, why: 'Linux only' }),
  seatbelt: () => (process.platform === 'darwin' && fs.existsSync(PROVIDER_COMMANDS.seatbelt) ? { ok: true, first: PROVIDER_COMMANDS.seatbelt, stdout: '' } : { ok: false, why: 'macOS only' }),
  vercel: () => {
    const present = VERCEL_AUTH.filter((name) => process.env[name]);

    return present.length > 0 ? { ok: true, first: `key present: ${present.join(', ')}`, stdout: '' } : { ok: false, why: `no key: none of ${VERCEL_AUTH.join(', ')} is set, and reap says UNVERIFIABLE` };
  },
} satisfies Record<keyof typeof PROVIDER_COMMANDS, () => ReturnType<typeof probe>>;

const CatalogSchema = z.object({ models: z.array(z.looseObject({ slug: z.string(), visibility: z.string().optional() })) });

/** Price of a million tokens in and out, by teamai's own price table, or undefined when it has none. */
function priceOf(model: string): number | undefined {
  return priceTokens({ model, tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 } })?.costMicros;
}

/** The cheapest model by teamai's prices among those a model catalog (`codex debug models`) lists for this login. */
export function cheapestListed(catalog: string): string | undefined {
  let parsed: z.infer<typeof CatalogSchema>;

  try {
    parsed = CatalogSchema.parse(JSON.parse(catalog));
  } catch {
    return undefined;
  }

  const priced = parsed.models.filter((model) => model.visibility === 'list').flatMap((model) => {
    const price = priceOf(model.slug);

    return price === undefined ? [] : [{ slug: model.slug, price }];
  });

  return priced.toSorted((a, b) => a.price - b.price)[0]?.slug;
}

/** Each tool's cheapest model, the one a world's real run uses: by name, or asked of the tool's own catalog for this login. */
const CHEAPEST_MODEL = {
  claude: () => 'haiku',
  codex: () => {
    const catalog = probe(['codex', 'debug', 'models']);

    return catalog.ok ? cheapestListed(catalog.stdout) : undefined;
  },
  codebuddy: () => undefined,
  opencode: () => undefined,
} satisfies Record<(typeof TOOL_COMMANDS)[number], () => string | undefined>;

/** The line `doctor <run> --drivers` gives sbx from what `sbx ls --no-input` answered in world `runId`. */
export function sbxInWorld(runId: string, ran: { code: number | null; why: string }) {
  if (ran.code === 0) return { good: true, text: 'sandbox sbx: signed in in this world' };

  // sbx ends its refusal with the command that signs in: `try: sbx login`.
  if (/\bsbx login\b/.test(ran.why)) return { good: false, text: `sandbox sbx: installed, not signed in in this world; sign in with \`npm run -s verify -- sh ${runId} sbx login\`. Claims on it are UNVERIFIABLE until then` };

  return { good: false, text: `sandbox sbx: \`sbx ls\` failed in this world (${ran.why}): claims on it are UNVERIFIABLE here` };
}

/**
 * Asks sbx in `world`, from its own HOME, whether it is signed in there. What sbx writes there is its own, as when a
 * maintainer runs it with `sh`, so it is recorded as sbx's.
 */
function askSbxIn(world: World) {
  const argv = [PROVIDER_COMMANDS.sbx, 'ls', '--json', '--no-input'];
  const before = worldFiles(world);
  const ran = captureOn(world, { kind: 'world' }, argv);
  recordWriters(worldWritersFile(world), argv, before, worldFiles(world));

  return sbxInWorld(world.runId, ran);
}

/** Prints the drivers section of doctor; with `world`, what sbx answers in it. */
export async function doctorDrivers(line: (good: boolean, text: string) => void, { world }: { world?: World } = {}): Promise<void> {
  for (const [provider, ready] of Object.entries(PROVIDER_READINESS)) {
    const answer = ready();
    line(answer.ok, answer.ok ? `sandbox ${provider}: ${answer.first}` : `sandbox ${provider}: ${answer.why}: claims on it are UNVERIFIABLE here`);

    if (provider !== 'sbx' || !answer.ok) continue;
    const signIn = world === undefined ? { good: false, text: 'sandbox sbx: signed in or not is per world; `doctor <run> --drivers` asks in that world' } : askSbxIn(world);
    line(signIn.good, signIn.text);
  }

  for (const { runtime, commands } of await runtimeHostCommands()) {
    for (const command of commands) {
      const found = probe(['/bin/sh', '-c', `command -v '${command}'`]);
      line(found.ok, found.ok ? `${runtime} runs ${command}: ${found.first}` : `${runtime} runs ${command}, not on PATH: claims on it are UNVERIFIABLE here`);
    }
  }

  for (const [tool, cheapest] of Object.entries(CHEAPEST_MODEL)) {
    const model = probe(['/bin/sh', '-c', `command -v ${tool}`]).ok ? cheapest() : undefined;
    line(model !== undefined, model === undefined ? `${tool}: no cheapest model known here; name one with the tool's model option` : `${tool}: cheapest model ${model}`);
  }

  const keys = Object.keys(collectEnvSecrets(process.env)).toSorted();
  line(true, keys.length === 0 ? 'keys present: none' : `keys present (names only): ${keys.join(', ')}`);
}
