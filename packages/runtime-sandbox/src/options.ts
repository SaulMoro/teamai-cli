import { z } from 'zod';
import type { RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';

// ─── Options, as a driver definition passes them at `init` ───
//
//  A `bad_option` message ends without a period: teamai quotes it inside its own sentence.
//
//    runtimes:
//      - use: sandbox
//        options:
//          provider: sbx                    # sbx | docker | podman
//          agent: claude                    # sbx, optional: the agent template (claude, codex) or a kit reference;
//                                           # unset, each attempt starts from its own tool's template
//      - use: sandbox
//        options:
//          provider: docker
//          image: ghcr.io/acme/agent:1      # docker, podman: a prebuilt image holding the tools
//
//  teamai reads `credentials` and `max_parallel` itself and never passes them here; it gives the credentials on `open`.
//  Each provider has its own schema, and a key it does not take fails with `bad_option` naming it.
//

/** The container engines this version runs. */
export const CONTAINER_ENGINES = ['docker', 'podman'] as const;

export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];

/** The providers this version runs. */
const PROVIDERS = ['sbx', ...CONTAINER_ENGINES] as const;

/** Providers the sandbox runtime is designed for that this version does not run yet. */
const LATER_PROVIDERS = ['bwrap', 'seatbelt', 'vercel'] as const;

const ContainerOptionsSchema = z.strictObject({
  provider: z.enum(CONTAINER_ENGINES),
  image: z.string({ error: 'Name the prebuilt image that holds the tools, for example image: ghcr.io/acme/agent:1' }).min(1),
});

const NAME_AN_AGENT = "Name the agent whose template each sandbox starts from: agent: claude, agent: codex, or a kit reference that brings the tools (sbx's bare shell template holds no agent), or leave agent out to start each attempt from its own tool's template";

const SbxOptionsSchema = z.strictObject({
  provider: z.literal('sbx'),
  agent: z.string({ error: NAME_AN_AGENT }).min(1, NAME_AN_AGENT).refine((agent) => agent !== 'shell', NAME_AN_AGENT).optional(),
});

const SCHEMAS = { sbx: SbxOptionsSchema, docker: ContainerOptionsSchema, podman: ContainerOptionsSchema } satisfies Record<(typeof PROVIDERS)[number], z.ZodObject>;

export type SandboxOptions = z.infer<typeof ContainerOptionsSchema> | z.infer<typeof SbxOptionsSchema>;

/** Parses a definition's options, or says which key is wrong and why. */
export function parseOptions(raw: RuntimeOptions): { ok: true; options: SandboxOptions } | { ok: false; failure: RuntimeFailure } {
  const provider = z.enum(PROVIDERS).safeParse(raw.provider);

  if (!provider.success) {
    const later = z.enum(LATER_PROVIDERS).safeParse(raw.provider);

    return {
      ok: false,
      failure: {
        code: 'bad_option', key: 'provider',
        message: later.success ? `Provider "${later.data}" is not available in this version of teamai-runtime-sandbox. Use provider: sbx, docker or podman`
          : `Set provider to sbx, docker or podman${raw.provider === undefined ? '' : `, not ${JSON.stringify(raw.provider)}`}`,
      },
    };
  }

  const schema = SCHEMAS[provider.data];
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    // A misspelled key is named before the key it was meant to be, which then reads as missing.
    const { issues } = parsed.error;
    const issue = issues.find((candidate) => candidate.code === 'unrecognized_keys') ?? issues[0];
    const key = issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path.join('.');
    const message = issue?.code === 'unrecognized_keys' ? `Provider ${provider.data} takes no option "${key}". It takes: ${Object.keys(schema.shape).join(', ')}` : issue?.message ?? 'Invalid option';

    return { ok: false, failure: { code: 'bad_option', key: key || 'options', message } };
  }

  return { ok: true, options: parsed.data };
}
