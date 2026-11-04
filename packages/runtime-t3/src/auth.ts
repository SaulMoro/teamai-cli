import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientInformationFullSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

// ─── The member's sign-in to a T3 environment ───
//
//  T3's MCP endpoint takes a credential its OAuth flow issues: the person approves this runtime once in T3's page,
//  and T3 grants a token for a limited time, with no refresh. The runtime keeps the client registration and the
//  token per endpoint in one file of its own, mode 0600, so a later run, attended or not, reuses them:
//
//    ~/.teamai/runtime-state/t3/credentials.json
//    { "http://127.0.0.1:3773/mcp": { "client": {...}, "tokens": {...}, "expiresAt": 1793600000000 } }
//

/** How long before its end a token stops counting as valid, so a step that starts on it does not lose it mid-run. */
const EXPIRY_MARGIN_MS = 10 * 60_000;

/** How long an attended sign-in waits for the person to approve it in T3's page. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const EntrySchema = z.object({
  client: OAuthClientInformationFullSchema.optional(),
  tokens: OAuthTokensSchema.optional(),
  expiresAt: z.number().optional(),
});

const StoreSchema = z.record(z.string(), EntrySchema);

type Entry = z.infer<typeof EntrySchema>;

/** The credentials file under `stateDir`, read and written whole; a file that does not parse counts as empty. */
function credentialStore(stateDir: string) {
  const file = path.join(stateDir, 'credentials.json');

  const read = (): z.infer<typeof StoreSchema> => {
    try {
      return StoreSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return {};
    }
  };

  return {
    file,
    entry: (resource: string): Entry => read()[resource] ?? {},
    update(resource: string, change: (entry: Entry) => Entry): void {
      const all = read();
      all[resource] = change(all[resource] ?? {});
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(all), { mode: 0o600 });
      fs.renameSync(temp, file);
    },
  };
}

/** The token kept for `resource`, while it has more than the margin left. */
export function validToken(stateDir: string, resource: string, now = Date.now()): OAuthTokens | undefined {
  const entry = credentialStore(stateDir).entry(resource);

  return entry.tokens && (entry.expiresAt === undefined || entry.expiresAt - EXPIRY_MARGIN_MS > now) ? entry.tokens : undefined;
}

/** The command that opens a URL in the person's browser on this platform. */
function opener(url: string): [string, string[]] {
  if (process.platform === 'darwin') return ['open', [url]];

  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];

  return ['xdg-open', [url]];
}

export interface SignIn {
  provider: OAuthClientProvider;
  /** The authorization code T3's page sends back once the person approves, after the SDK sent them there. */
  code(): Promise<string>;
  close(): void;
}

/**
 * An attended sign-in for `resource`: a loopback listener for T3's redirect, and the SDK's OAuth client over the
 * credentials file. The page opens in the person's browser; its link also goes to stderr, for a browser that does not open.
 */
export async function attendedSignIn(stateDir: string, resource: string): Promise<SignIn> {
  const store = credentialStore(stateDir);
  let verifier = '';
  let answer: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  const answered = new Promise<string>((resolve, reject) => { answer = { resolve, reject }; });
  // A rejection nobody awaits yet must not end the process.
  answered.catch(() => {});

  const listener = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (url.pathname !== '/callback' || (!code && !error)) {
      res.writeHead(404).end();

      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(code
      ? '<!doctype html><title>teamai</title><p>teamai is signed in to T3 Code. You can close this page.</p>'
      : '<!doctype html><title>teamai</title><p>T3 Code did not sign teamai in. Close this page and start the workflow again to retry.</p>');

    if (code) answer?.resolve(code);
    else answer?.reject(new Error(`T3 Code refused the sign-in (${error}).`));
  });

  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = z.object({ port: z.number().int() }).parse(listener.address());
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => answer?.reject(new Error('Nobody approved the T3 Code sign-in within 5 minutes.')), APPROVAL_TIMEOUT_MS);

  const provider: OAuthClientProvider = {
    redirectUrl,
    clientMetadata: {
      client_name: 'teamai workflow',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'orchestration:read orchestration:operate',
    },
    clientInformation: (): OAuthClientInformationMixed | undefined => store.entry(resource).client,
    saveClientInformation: (client) => {
      const full = OAuthClientInformationFullSchema.safeParse(client);

      if (full.success) store.update(resource, (entry) => ({ ...entry, client: full.data }));
    },
    tokens: () => validToken(stateDir, resource),
    saveTokens: (tokens) => {
      store.update(resource, (entry) => ({ ...entry, tokens, ...(tokens.expires_in === undefined ? { expiresAt: undefined } : { expiresAt: Date.now() + tokens.expires_in * 1000 }) }));
    },
    redirectToAuthorization: (authorizationUrl) => {
      process.stderr.write(`Approve teamai in T3 Code to run workflow steps as threads: ${authorizationUrl.toString()}\n`);
      const [command, args] = opener(authorizationUrl.toString());
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    },
    saveCodeVerifier: (codeVerifier) => { verifier = codeVerifier; },
    codeVerifier: () => verifier,
  };

  return {
    provider,
    code: () => answered,
    close: () => {
      clearTimeout(timer);
      listener.close();
    },
  };
}

/** An unattended client: the kept token or nothing, and no sign-in, since nobody is there to approve one. */
export function unattendedAuth(stateDir: string, resource: string): OAuthClientProvider {
  return {
    redirectUrl: undefined,
    clientMetadata: { client_name: 'teamai workflow', redirect_uris: [] },
    clientInformation: () => credentialStore(stateDir).entry(resource).client,
    tokens: () => validToken(stateDir, resource),
    saveTokens: () => {},
    redirectToAuthorization: () => { throw new Error('An unattended run cannot sign in to T3 Code.'); },
    saveCodeVerifier: () => {},
    codeVerifier: () => '',
  };
}
