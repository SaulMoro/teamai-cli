import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createPaseoApi } from '@getpaseo/client';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { buildAgentDeepLink } from '@getpaseo/protocol/agent-deep-link';
import { findOnPath } from '@teamai/tool-core/lookpath';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import type WebSocket from 'ws';
import { z } from 'zod';

// ─── The Paseo client ────────────────────────────────────
//
//  Paseo is a prerequisite the member installs, and teamai ships none of its code: this runtime loads @getpaseo/client
//  from the installed Paseo when it starts, so the client always matches the member's daemon.
//
//    PASEO_CLIENT_PATH          the directory of an @getpaseo/client package, when set
//    else `paseo` on PATH       its real path, then the CLI package that holds it, whose dependencies hold the client
//
//  The client's own dependencies, @getpaseo/protocol and ws, resolve from the client's directory, as its code does.
//

const INSTALL = 'Install Paseo (npm install -g @getpaseo/cli) so `paseo` is on PATH, or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.';

/** What this runtime uses of the installed client. Typed by the version it is tested against; the daemon's version is checked at connect. */
export interface PaseoClient {
  createPaseoApi: typeof createPaseoApi;
  DaemonClient: typeof DaemonClient;
  buildAgentDeepLink: typeof buildAgentDeepLink;
  WebSocket: typeof WebSocket;
}

const ManifestSchema = z.object({ name: z.string() });

/** Whether `dir` holds the package named `name`. */
function isPackage(dir: string, name: string): boolean {
  try {
    return ManifestSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))).data?.name === name;
  } catch {
    return false;
  }
}

/** The nearest directory at or above `start` that holds the package named `name`. */
function packageDir(start: string, name: string): string | undefined {
  for (let at = start; ; at = path.dirname(at)) {
    if (isPackage(at, name)) return at;

    if (path.dirname(at) === at) return undefined;
  }
}

/** The directory of the client package, or why none was found, as the end of a sentence that starts "found no Paseo client". */
function clientDir(env: NodeJS.ProcessEnv): { dir: string } | { missing: string } {
  const given = env.PASEO_CLIENT_PATH;

  if (given) {
    const dir = path.resolve(given);

    return isPackage(dir, '@getpaseo/client') ? { dir } : { missing: ` in ${given}, which PASEO_CLIENT_PATH names` };
  }

  const cli = findOnPath('paseo', { pathEnv: env.PATH });

  if (!cli) return { missing: ': it found no `paseo` on PATH' };
  const real = fs.realpathSync(cli);
  const cliDir = packageDir(path.dirname(real), '@getpaseo/cli');

  if (!cliDir) return { missing: ` for ${real}, which is not inside the @getpaseo/cli package` };

  try {
    const entry = createRequire(path.join(cliDir, 'package.json')).resolve('@getpaseo/client');
    const dir = packageDir(path.dirname(entry), '@getpaseo/client');

    return dir ? { dir } : { missing: ` beside ${real}` };
  } catch {
    return { missing: ` beside ${real}` };
  }
}

/** A module export this runtime calls or constructs. */
// oxlint-disable-next-line teamai/no-runtime-typeof -- an export is code, not data: being a function is all there is to check before calling it
const ExportedFunctionSchema = z.custom<object>((exported) => typeof exported === 'function', 'not a function');

/** Export `name` of the module `specifier` resolves to from the client's directory, once it is checked to be a function. */
async function loadExport<TExport extends object>(from: string, specifier: string, name: string): Promise<TExport> {
  const loaded: unknown = await import(pathToFileURL(createRequire(path.join(from, 'package.json')).resolve(specifier)).href);
  const parsed = z.object({ [name]: ExportedFunctionSchema }).safeParse(loaded);

  if (!parsed.success) throw new Error(`${specifier} exports no function ${name}`);

  // SAFETY: the export is a function of the installed client, the version the member runs; its signature is typed by
  // the version this runtime is tested against, and connect refuses a daemon older than that.
  return parsed.data[name] as TExport;
}

/** Loads the installed Paseo client, or says what is missing and how to install it. */
export async function loadClient(env: NodeJS.ProcessEnv): Promise<PaseoClient | RuntimeFailure> {
  const found = clientDir(env);

  if ('missing' in found) return { code: 'client_missing', message: `teamai-runtime-paseo found no Paseo client${found.missing}. ${INSTALL}` };

  try {
    const [api, daemon, link, socket] = await Promise.all([
      loadExport<typeof createPaseoApi>(found.dir, '@getpaseo/client', 'createPaseoApi'),
      loadExport<typeof DaemonClient>(found.dir, '@getpaseo/client/internal/daemon-client', 'DaemonClient'),
      loadExport<typeof buildAgentDeepLink>(found.dir, '@getpaseo/protocol/agent-deep-link', 'buildAgentDeepLink'),
      loadExport<typeof WebSocket>(found.dir, 'ws', 'default'),
    ]);

    return { createPaseoApi: api, DaemonClient: daemon, buildAgentDeepLink: link, WebSocket: socket };
  } catch (error) {
    return {
      code: 'client_missing',
      message: `teamai-runtime-paseo could not load the Paseo client in ${found.dir}: ${error instanceof Error ? error.message : String(error)}. Update Paseo, or set PASEO_CLIENT_PATH to the directory of a working @getpaseo/client package.`,
    };
  }
}
