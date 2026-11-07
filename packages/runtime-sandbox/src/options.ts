import { z } from 'zod';
import type { RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';

// ─── Options, as a driver definition passes them at `init` ───
//
//  A `bad_option` message ends without a period: teamai quotes it inside its own sentence.
//
//    runtimes:
//      - use: sandbox
//        options:
//          provider: sbx                    # sbx | docker | podman | seatbelt | bwrap
//          agent: claude                    # sbx, optional: the agent template (claude, codex) or a kit reference;
//                                           # unset, each attempt starts from its own tool's template
//      - use: sandbox
//        options:
//          provider: docker
//          image: ghcr.io/acme/agent:1      # docker, podman: a prebuilt image holding the tools
//      - use: sandbox
//        options:
//          provider: seatbelt               # seatbelt (macOS), bwrap (Linux): this machine's own tools, no other key
//
//  teamai reads `credentials` and `max_parallel` itself and never passes them here; it gives the credentials on `open`.
//  Each provider has its own schema, and a key it does not take fails with `bad_option` naming it.
//

/** The container engines this version runs. */
export const CONTAINER_ENGINES = ['docker', 'podman'] as const;

export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];

/** The native sandboxes of the operating system, which run each exec on this machine's own tools. */
export const NATIVE_SANDBOXES = ['seatbelt', 'bwrap'] as const;

export type NativeProvider = (typeof NATIVE_SANDBOXES)[number];

/** The providers this version runs. */
const PROVIDERS = ['sbx', ...CONTAINER_ENGINES, ...NATIVE_SANDBOXES] as const;

/** Providers the sandbox runtime is designed for that this version does not run yet. */
const LATER_PROVIDERS = ['vercel'] as const;

const CACHE = 'List the manifests and lockfiles that key the warm image, relative to the checkout, for example cache: [package.json, package-lock.json]';

const CacheSchema = z.array(z.string().min(1, CACHE), { error: CACHE }).min(1, CACHE);

const PrepareSchema = z.string({ error: 'Give the command that installs the dependencies, for example prepare: npm ci --ignore-scripts' }).min(1);

/** A warm image made by running `prepare` on the base, keyed by the `cache` files. */
const PreparedWarmSchema = z.strictObject({ prepare: PrepareSchema, cache: CacheSchema });

/**
 * A warm image on docker or podman: `prepare` run on the base, or a `containerfile` built with only the `cache` files in
 * its context, never both.
 */
const ContainerWarmSchema = z.strictObject({
  prepare: PrepareSchema.optional(),
  containerfile: z.string({ error: 'Give the path of the Containerfile, relative to the checkout' }).min(1).optional(),
  cache: CacheSchema,
}).transform(({ prepare, containerfile, cache }, context) => {
  if (prepare !== undefined && containerfile === undefined) return { prepare, cache };

  if (containerfile !== undefined && prepare === undefined) return { containerfile, cache };
  context.addIssue({ code: 'custom', message: 'Give warm either prepare or containerfile, not both and not neither', path: [] });

  return z.NEVER;
});

/** The keys `warm` takes on each provider that takes it. */
const WARM_KEYS: Partial<Record<(typeof PROVIDERS)[number], readonly string[]>> = {
  sbx: Object.keys(PreparedWarmSchema.shape),
  docker: Object.keys(ContainerWarmSchema.in.shape),
  podman: Object.keys(ContainerWarmSchema.in.shape),
};

/** How a warm image is made: by a prepare command, or by a Containerfile (docker and podman only). */
export type WarmOptions = z.infer<typeof ContainerWarmSchema>;

const ContainerOptionsSchema = z.strictObject({
  provider: z.enum(CONTAINER_ENGINES),
  image: z.string({ error: 'Name the prebuilt image that holds the tools, for example image: ghcr.io/acme/agent:1' }).min(1),
  warm: ContainerWarmSchema.optional(),
});

const NAME_AN_AGENT = "Name the agent whose template each sandbox starts from: agent: claude, agent: codex, or a kit reference that brings the tools (sbx's bare shell template holds no agent), or leave agent out to start each attempt from its own tool's template";

const SbxOptionsSchema = z.strictObject({
  provider: z.literal('sbx'),
  agent: z.string({ error: NAME_AN_AGENT }).min(1, NAME_AN_AGENT).refine((agent) => agent !== 'shell', NAME_AN_AGENT).optional(),
  warm: PreparedWarmSchema.optional(),
});

/** seatbelt and bwrap take only their provider: the tools are this machine's own, on its PATH. */
const NativeOptionsSchema = z.strictObject({ provider: z.enum(NATIVE_SANDBOXES) });

const SCHEMAS = { sbx: SbxOptionsSchema, docker: ContainerOptionsSchema, podman: ContainerOptionsSchema, seatbelt: NativeOptionsSchema, bwrap: NativeOptionsSchema } satisfies Record<(typeof PROVIDERS)[number], z.ZodObject>;

export type SandboxOptions = z.infer<typeof ContainerOptionsSchema> | z.infer<typeof SbxOptionsSchema> | z.infer<typeof NativeOptionsSchema>;

/** What a key `issue` says no option takes means, naming the keys there are; undefined for another issue. */
function unknownKeyMessage(issue: z.core.$ZodIssue | undefined, provider: (typeof PROVIDERS)[number], topKeys: string[]): string | undefined {
  if (issue?.code !== 'unrecognized_keys') return undefined;

  if (issue.path.length === 0) return `Provider ${provider} takes no option "${issue.keys[0]}". It takes: ${topKeys.join(', ')}`;

  return `On provider ${provider}, ${issue.path.join('.')} takes no key "${issue.keys[0]}". It takes: ${(WARM_KEYS[provider] ?? []).join(', ')}`;
}

/** Parses a definition's options, or says which key is wrong and why. */
export function parseOptions(raw: RuntimeOptions): { ok: true; options: SandboxOptions } | { ok: false; failure: RuntimeFailure } {
  const provider = z.enum(PROVIDERS).safeParse(raw.provider);

  if (!provider.success) {
    const later = z.enum(LATER_PROVIDERS).safeParse(raw.provider);

    return {
      ok: false,
      failure: {
        code: 'bad_option', key: 'provider',
        message: later.success ? `Provider "${later.data}" is not available in this version of teamai-runtime-sandbox. Use provider: sbx, docker, podman, seatbelt or bwrap`
          : `Set provider to sbx, docker, podman, seatbelt or bwrap${raw.provider === undefined ? '' : `, not ${JSON.stringify(raw.provider)}`}`,
      },
    };
  }

  const schema = SCHEMAS[provider.data];
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    // A misspelled key is named before the key it was meant to be, which then reads as missing.
    const { issues } = parsed.error;
    const issue = issues.find((candidate) => candidate.code === 'unrecognized_keys') ?? issues[0];
    const key = issue?.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys.slice(0, 1)].join('.') : issue?.path.join('.');
    const message = unknownKeyMessage(issue, provider.data, Object.keys(schema.shape)) ?? issue?.message ?? 'Invalid option';

    return { ok: false, failure: { code: 'bad_option', key: key || 'options', message } };
  }

  return { ok: true, options: parsed.data };
}
