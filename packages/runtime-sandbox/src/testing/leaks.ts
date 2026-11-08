import fs from 'node:fs';
import path from 'node:path';
import { expectNothingLeft as expectNothingLeftBy } from '@teamai/runtime-testing/leaks';
import { connect, type Connection } from './harness.js';

// ─── What a test left behind ───
//
//  Every sandbox harness ends a test with `expectNothingLeft`, so a test that leaves a process, a container, an
//  attempt's state directory or a hosted sandbox fails, and a new test is checked without asking (after sandcastle's
//  testGlobalSetup.ts and "leaves no temp dir behind" checks). What a runtime said it leaves, in an answer's `kept`, is
//  no leak: `@teamai/runtime-testing/leaks` reads it from the connections' lines.
//

/** The test's own directory, its runtimes, and what else it may have made a sandbox in. */
export interface Scope {
  /** The test's directory: everything it made is under it. */
  dir: string;
  /** Every runtime the test started, the ones `closeLeftovers` started included. */
  connections?: readonly Connection[];
  /** The fake engine's containers (and sbx sandboxes), when the test runs one. */
  containers?: () => string[];
  /** The fake Vercel's state directory, when the test runs it. */
  vercelState?: string;
  /** What the test planted itself, or what the runtime leaves by its contract and the test asserts it does, by name. */
  kept?: readonly string[];
}

/** An attempt's state directory, as a provider names it: `teamai-<run>-<attempt>`, after an owner id on sbx. */
const ATTEMPT_DIR = /^teamai-(?:[0-9a-f]{16}-)?r[0-9a-f]+-a[0-9a-f]+$/;

/** Every directory under the runtime state of a home under `dir` that is an attempt's. */
function attemptDirsUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isDirectory() && ATTEMPT_DIR.test(entry.name) && entry.parentPath.includes(`${path.sep}runtime-state${path.sep}`)).map((entry) => path.join(entry.parentPath, entry.name));
}

/** What the test left of sandboxes, as `<kind> <name>`: containers, attempts' state directories, hosted sandboxes. */
function sandboxesLeft({ dir, containers, vercelState, kept = [] }: Scope): string[] {
  const sandboxes = vercelState === undefined ? undefined : path.join(vercelState, 'sandboxes');

  return [
    ...(containers?.() ?? []).filter((name) => !kept.includes(name)).map((name) => `container ${name}`),
    ...(fs.existsSync(dir) ? attemptDirsUnder(dir).filter((at) => !kept.includes(path.basename(at))).map((at) => `attempt ${at}`) : []),
    ...(sandboxes !== undefined && fs.existsSync(sandboxes) ? fs.readdirSync(sandboxes).map((name) => `vercel ${name}`) : []),
  ];
}

/**
 * Fails the test, naming each thing it left, when it left anything: a runtime still running, a process naming its
 * directory, or a sandbox, but what a runtime said it keeps and what the test kept.
 */
export function expectNothingLeft(scope: Scope): Promise<void> {
  return expectNothingLeftBy({ dir: scope.dir, connections: (scope.connections ?? []).map(({ runtime }) => runtime), left: () => sandboxesLeft(scope) });
}

/**
 * Closes every place a test's runtimes left in their journal, as teamai does after a crash: a runtime started again in
 * `recover` mode on the same home, with the options the test's last `init` gave, and a `close` of each place. What is
 * left after that is a leak of the runtime's own, which `expectNothingLeft` names.
 */
export async function closeLeftovers(connections: Connection[]): Promise<{ invalid: string[]; recovered: Connection[] }> {
  const invalid: string[] = [];
  const recovered: Connection[] = [];
  const homes = new Map<string, Connection>();

  for (const connection of connections) {
    if (connection.env.HOME !== undefined && connection.sent.some((request) => request.type === 'init')) homes.set(connection.env.HOME, connection);
  }

  for (const [home, last] of homes) {
    const places = path.join(home, '.teamai', 'runtime-state', 'sandbox', 'places');
    const handles = fs.existsSync(places) ? fs.readdirSync(places).filter((name) => name.endsWith('.json')).map((name) => decodeURIComponent(name.slice(0, -'.json'.length))) : [];

    if (handles.length === 0) continue;
    const options = connections.filter((connection) => connection.env.HOME === home).flatMap((connection) => connection.sent).findLast((request) => request.type === 'init')?.options ?? {};
    const recover = connect(last.executable, last.env);
    recovered.push(recover);
    recover.send({ type: 'init', protocol: 1, mode: 'recover', options });
    await recover.next((message) => message.type === 'init', 30_000);

    for (const handle of handles) {
      recover.send({ type: 'close', handle });
      await recover.next((message) => message.handle === handle && (message.event === 'closed' || message.event === 'failed'), 60_000);
    }

    await recover.end();
    invalid.push(...recover.invalid);
  }

  return { invalid, recovered };
}
