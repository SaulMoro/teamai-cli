import type { InitCredentials, RuntimeFailure } from '@teamai/runtime-protocol';

// ─── Whether a tool can sign in inside a sandbox ─────────
//
//  A sandbox holds none of the member's own logins: a Claude login in the macOS Keychain or in ~/.claude, or Codex's
//  daily ~/.codex, never crosses into it. A tool is offered only when it can sign in there, the first that holds:
//
//    sbx      the service sbx's proxy holds a login for (`sbx secret ls`), which it injects and never lets in
//    teamai   a sign-in variable teamai gives each of the tool's execs by name (`init.credentials.env`)
//             a login teamai copies into the attempt's tool home (`init.credentials.logins`, `codex: login`)
//
//  Otherwise a step would start and stop at the tool's own "Not logged in", whose next step cannot be followed there.
//  Until teamai reads a reason per tool it does not offer, a runtime that can sign none of its tools in fails `init`
//  with how to sign each one in, and one that signs some in offers only those.
//

/** The providers a tool signs in on, which decides how to sign it in. */
export type SignInProvider = 'sbx' | 'docker' | 'podman';

interface SignIn {
  /** The variables the tool signs in with, in the order a member is pointed at them. */
  env: readonly string[];
  /** The sbx service whose stored login sbx's proxy injects for it, when sbx keeps one. */
  sbx?: string;
  /** How to sign it in, as the rest of a sentence that starts with the tool's name, per provider. */
  hint: Record<SignInProvider, string>;
}

const CLAUDE_TOKEN = 'run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN to the sandbox\'s credentials (or an API key, ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY)';

const CLAUDE_IN_A_CONTAINER = `a Claude login kept in the macOS Keychain or in ~/.claude never crosses into a container; ${CLAUDE_TOKEN}`;

const CODEX_IN_A_CONTAINER = 'add codex: login to the sandbox\'s credentials, the login teamai keeps apart from your daily one (create it once with `CODEX_HOME=~/.teamai/logins/codex codex login`), or an API key, OPENAI_API_KEY: env:OPENAI_API_KEY';

const CODEBUDDY = 'add CODEBUDDY_API_KEY: env:CODEBUDDY_API_KEY to the sandbox\'s credentials';

/** How each tool a step runtime launches signs in inside a sandbox, by its executable. */
// oxlint-disable-next-line teamai/tool-facts -- the sign-in of each tool in LAUNCHABLE (providers/cli.ts) inside a sandbox; a runtime package cannot read teamai's tool registry
export const SIGN_IN = {
  claude: {
    env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    sbx: 'anthropic',
    hint: {
      sbx: `sign Claude in once with sbx: run \`sbx run claude <any dir>\`, then \`/login\` in Claude Code, and every new sandbox reuses that login (an API key instead: \`sbx secret set anthropic\`); or ${CLAUDE_TOKEN}`,
      docker: CLAUDE_IN_A_CONTAINER,
      podman: CLAUDE_IN_A_CONTAINER,
    },
  },
  codex: {
    env: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    sbx: 'openai',
    hint: {
      sbx: 'sign Codex in once with sbx, `sbx secret set openai --oauth` (or store an API key with `sbx secret set openai`), or add OPENAI_API_KEY: env:OPENAI_API_KEY to the sandbox\'s credentials',
      docker: CODEX_IN_A_CONTAINER,
      podman: CODEX_IN_A_CONTAINER,
    },
  },
  codebuddy: { env: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'], hint: { sbx: CODEBUDDY, docker: CODEBUDDY, podman: CODEBUDDY } },
} satisfies Record<string, SignIn>;

/** How `tool` signs in inside a sandbox, when this runtime knows. */
function signInOf(tool: string): SignIn | undefined {
  return Object.entries(SIGN_IN).find(([name]) => name === tool)?.[1];
}

/** Whether teamai gives `tool` a sign-in: one of its variables, or its login copied into the attempt's tool home. */
export function isGivenSignIn(tool: string, credentials: InitCredentials): boolean {
  return credentials.logins.includes(tool) || signInOf(tool)?.env.some((name) => credentials.env.includes(name)) === true;
}

/**
 * The tools of `tools` that can sign in on `provider`: by a credential teamai gives, or, on sbx, by the login sbx keeps
 * for its service (`stored`). It fails `credential_missing`, with how to sign each one in, when there were tools and
 * none can. An older teamai names no credentials: every tool is offered, as before.
 */
export function offerSignedIn({ tools, provider, credentials, stored }: { tools: string[]; provider: SignInProvider; credentials: InitCredentials | undefined; stored: ReadonlySet<string> }): { ok: true; tools: string[] } | { ok: false; failure: RuntimeFailure } {
  if (credentials === undefined) return { ok: true, tools };

  const isStored = (tool: string): boolean => {
    const service = signInOf(tool)?.sbx;

    return service !== undefined && stored.has(service);
  };

  const signedIn = tools.filter((tool) => isGivenSignIn(tool, credentials) || isStored(tool));

  if (signedIn.length > 0 || tools.length === 0) return { ok: true, tools: signedIn };
  const how = tools.map((tool) => `${tool}: ${signInOf(tool)?.hint[provider] ?? 'teamai knows no way to sign it in inside a sandbox'}.`);

  return { ok: false, failure: { code: 'credential_missing', message: `No tool in this ${provider} sandbox can sign in, so every step there would stop at the tool's own "Not logged in". ${how.join(' ')} Then start again.` } };
}
