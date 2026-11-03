import { z } from 'zod';
import type { RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';

// ─── Options, as a driver definition passes them at `init` ───
//
//  A `bad_option` message ends without a period: teamai quotes it inside its own sentence.
//
//    runtimes:
//      - use: sandbox
//        options:
//          provider: docker                 # docker | podman
//          image: ghcr.io/acme/agent:1      # a prebuilt image holding the tools
//
//  teamai reads `credentials` and `max_parallel` itself and never passes them here; it gives the credentials on `open`.
//  Each provider has its own schema, and a key it does not take fails with `bad_option` naming it.
//

/** The providers this version runs. */
export const CONTAINER_ENGINES = ['docker', 'podman'] as const;

export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];

/** Providers the sandbox runtime is designed for that this version does not run yet. */
const LATER_PROVIDERS = ['sbx', 'bwrap', 'seatbelt', 'vercel'] as const;

const ContainerOptionsSchema = z.strictObject({
  provider: z.enum(CONTAINER_ENGINES),
  image: z.string({ error: 'Name the prebuilt image that holds the tools, for example image: ghcr.io/acme/agent:1' }).min(1),
});

export type SandboxOptions = z.infer<typeof ContainerOptionsSchema>;

/** Parses a definition's options, or says which key is wrong and why. */
export function parseOptions(raw: RuntimeOptions): { ok: true; options: SandboxOptions } | { ok: false; failure: RuntimeFailure } {
  if (!z.object({ provider: z.enum(CONTAINER_ENGINES) }).safeParse(raw).success) {
    const later = z.object({ provider: z.enum(LATER_PROVIDERS) }).safeParse(raw);

    return {
      ok: false,
      failure: {
        code: 'bad_option', key: 'provider',
        message: later.success ? `Provider "${later.data.provider}" is not available in this version of teamai-runtime-sandbox. Use provider: docker or provider: podman`
          : `Set provider to docker or podman${raw.provider === undefined ? '' : `, not ${JSON.stringify(raw.provider)}`}`,
      },
    };
  }

  const parsed = ContainerOptionsSchema.safeParse(raw);

  if (!parsed.success) {
    // A misspelled key is named before the key it was meant to be, which then reads as missing.
    const { issues } = parsed.error;
    const issue = issues.find((candidate) => candidate.code === 'unrecognized_keys') ?? issues[0];
    const key = issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path.join('.');
    const message = issue?.code === 'unrecognized_keys' ? `Provider ${String(raw.provider)} takes no option "${key}". It takes: ${Object.keys(ContainerOptionsSchema.shape).join(', ')}` : issue?.message ?? 'Invalid option';

    return { ok: false, failure: { code: 'bad_option', key: key || 'options', message } };
  }

  return { ok: true, options: parsed.data };
}
