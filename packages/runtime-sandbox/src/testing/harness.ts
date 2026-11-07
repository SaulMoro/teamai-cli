import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RuntimeMessageSchema } from '@teamai/runtime-protocol';
import { build } from 'esbuild';
import { z } from 'zod';

// ─── Test support: the runtime over its stdio, on a fake container engine ───
//
//  `bundleRuntime` builds the executable as the package ships it. `fakeEngine` lays out a `docker`, a `podman` and an
//  `sbx` on a PATH of their own, backed by fake-engine.mjs, with images (and sbx agents) whose tools are scripts in a
//  directory. `connect` starts
//  the runtime and speaks protocol 1 to it as JSON lines.
//

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = path.join(HERE, 'fake-engine.mjs');
const ENTRY = path.join(HERE, '..', 'main.ts');

/** Builds the runtime's executable into `dir`, as tsup bundles it, and returns its path. */
export async function bundleRuntime(dir: string): Promise<string> {
  const outfile = path.join(dir, 'teamai-runtime-sandbox.mjs');

  await build({
    entryPoints: [ENTRY], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
  });

  return outfile;
}

export interface FakeEngine {
  /** The directory `docker`, `podman` and `sbx` are in. */
  bin: string;
  state: string;
  log: string;
  /** The image (or sbx agent) `name`, holding `tools` as scripts that run `body` in node. */
  image(name: string, tools: Record<string, string>): void;
  /** Stops or starts the fake daemon. */
  daemon(up: boolean): void;
  /** Makes `rm` fail, as a daemon that cannot remove a container, or work again. */
  failRemove(shouldFail: boolean): void;
  /** Makes an exec whose process a stop or remove killed end `ms` after the command that killed it returned. */
  stopLag(ms: number): void;
  /** Makes a stop wait `ms` before it stops anything, as a daemon slow to answer. */
  stopDelay(ms: number): void;
  /** Makes a stop wait `ms` once it stopped the processes, before it answers, as an engine that restarts the container. */
  stopHold(ms: number): void;
  /** Makes every later run of `command` (`run`, `rm`, …) wait `ms` before it does anything; 0 lets it run at once again. */
  delay(command: string, ms: number): void;
  /** Makes `ps --format` fail, as an engine that cannot render the format, or work again. */
  failFormat(shouldFail: boolean): void;
  /** Makes every later `run -d` wait `ms` once its container exists, before it answers; 0 answers at once again. */
  holdCreate(ms: number): void;
  /**
   * Makes every later `exec` wait `ms` before it starts its process: docker's or podman's once it found its container,
   * sbx's before it looks its sandbox up; 0 starts at once again.
   */
  holdExec(ms: number): void;
  /** Holds every later list of one journal's containers (`ps --filter label=teamai.owner=…`) until released. */
  holdOwned(isHeld: boolean): void;
  /** Whether a held list of one journal's containers is waiting now. */
  isListingOwned(): boolean;
  /** How many lists of one journal's containers it answered, as a sweep makes once per open. */
  ownedListings(): number;
  /** Stores or removes an sbx secret for `service`, which sbx's proxy injects; a sandbox sees only its placeholder. */
  secret(service: string, isSet: boolean): void;
  /** Makes sbx answer as one whose global network policy was initialized, or never was. */
  policy(isInitialized: boolean): void;
  /** Adds an allow rule for `target` (`localhost:<port>`) to sbx's network policy, as `sbx policy allow network` would. */
  allowNetwork(target: string): void;
  /** Every argv the engine was run with, as `[engine, ...args]`. */
  calls(): string[][];
  /** The containers (and sbx sandboxes) that exist, by name. */
  containers(): string[];
  /** The labels of the container named `name`, or undefined when there is none. */
  labelsOf(name: string): Record<string, string> | undefined;
  /** The networks that exist, by name. */
  networks(): string[];
  /** The tags of the images (sbx: templates) a `commit`, `build` or `template save` made. */
  savedImages(): string[];
  /** Every file a saved image holds in its home, and, for a built one, in its build context, each with its content. */
  savedFiles(tag: string): { home: Record<string, string>; context: Record<string, string> };
  env(): NodeJS.ProcessEnv;
}

/** Every file under `root`, by its path relative to it, with its content; none when it does not exist. */
function filesUnder(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {};

  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(String).filter((file) => fs.lstatSync(path.join(root, file)).isFile()).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
}

const StoredSchema = z.object({ name: z.string(), labels: z.record(z.string(), z.string()) });

export function fakeEngine(dir: string): FakeEngine {
  const bin = path.join(dir, 'engine-bin');
  const state = path.join(dir, 'engine-state');
  const log = path.join(dir, 'engine.log');
  const images: Record<string, string> = {};
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  /** Every container (and sbx sandbox) the fake engine holds, with its name and labels. */
  const stored = (): Array<z.infer<typeof StoredSchema>> => {
    const root = path.join(state, 'containers');

    return (fs.existsSync(root) ? fs.readdirSync(root) : []).flatMap((id) => {
      const file = path.join(root, id, 'container.json');

      return fs.existsSync(file) ? [StoredSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))] : [];
    });
  };

  for (const engine of ['docker', 'podman', 'sbx']) {
    fs.writeFileSync(path.join(bin, engine), `#!/bin/sh\nFAKE_ENGINE_NAME=${engine} exec "${process.execPath}" "${FAKE_ENGINE}" "$@"\n`, { mode: 0o755 });
  }

  return {
    bin, state, log,
    image(name, tools) {
      const at = path.join(dir, 'images', encodeURIComponent(name));
      fs.mkdirSync(at, { recursive: true });

      for (const [tool, body] of Object.entries(tools)) fs.writeFileSync(path.join(at, tool), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
      images[name] = at;
    },
    daemon(up) {
      if (up) fs.rmSync(path.join(state, 'down'), { force: true });
      else fs.writeFileSync(path.join(state, 'down'), '');
    },
    stopLag(ms) {
      fs.writeFileSync(path.join(state, 'stop-lag'), String(ms));
    },
    stopDelay(ms) {
      fs.writeFileSync(path.join(state, 'stop-delay'), String(ms));
    },
    stopHold(ms) {
      fs.writeFileSync(path.join(state, 'stop-hold'), String(ms));
    },
    delay(command, ms) {
      fs.writeFileSync(path.join(state, `delay-${command}`), String(ms));
    },
    failFormat(shouldFail) {
      if (shouldFail) fs.writeFileSync(path.join(state, 'format-fails'), '');
      else fs.rmSync(path.join(state, 'format-fails'), { force: true });
    },
    holdCreate(ms) {
      fs.writeFileSync(path.join(state, 'create-hold'), String(ms));
    },
    holdExec(ms) {
      fs.writeFileSync(path.join(state, 'exec-hold'), String(ms));
    },
    holdOwned(isHeld) {
      if (isHeld) fs.writeFileSync(path.join(state, 'owned-hold'), '');
      else fs.rmSync(path.join(state, 'owned-hold'), { force: true });
    },
    isListingOwned: () => fs.existsSync(path.join(state, 'owned-listing')),
    ownedListings: () => (fs.existsSync(path.join(state, 'owned-listed')) ? fs.readFileSync(path.join(state, 'owned-listed'), 'utf8').length : 0),
    failRemove(shouldFail) {
      if (shouldFail) fs.writeFileSync(path.join(state, 'rm-fails'), '');
      else fs.rmSync(path.join(state, 'rm-fails'), { force: true });
    },
    secret(service, isSet) {
      fs.mkdirSync(path.join(state, 'secrets'), { recursive: true });

      if (isSet) fs.writeFileSync(path.join(state, 'secrets', service), '');
      else fs.rmSync(path.join(state, 'secrets', service), { force: true });
    },
    allowNetwork(target) {
      fs.appendFileSync(path.join(state, 'allowed-network'), `${target}\n`);
    },
    policy(isInitialized) {
      if (isInitialized) fs.rmSync(path.join(state, 'no-policy'), { force: true });
      else fs.writeFileSync(path.join(state, 'no-policy'), '');
    },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => z.array(z.string()).parse(JSON.parse(line))) : []),
    containers: () => stored().map(({ name }) => name),
    labelsOf: (name) => stored().find((container) => container.name === name)?.labels,
    savedImages: () => (fs.existsSync(path.join(state, 'saved')) ? fs.readdirSync(path.join(state, 'saved')).map(decodeURIComponent).sort() : []),
    savedFiles: (tag) => ({ home: filesUnder(path.join(state, 'saved', encodeURIComponent(tag), 'home')), context: filesUnder(path.join(state, 'saved', encodeURIComponent(tag), 'context')) }),
    networks: () => (fs.existsSync(path.join(state, 'networks')) ? fs.readdirSync(path.join(state, 'networks')).sort() : []),
    env: () => ({ PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, FAKE_ENGINE_STATE: state, FAKE_ENGINE_LOG: log, FAKE_ENGINE_IMAGES: JSON.stringify(images) }),
  };
}

const MessageSchema = z.record(z.string(), z.json());

/** A line the runtime wrote, parsed. */
export type Message = z.infer<typeof MessageSchema>;

export interface Connection {
  child: ChildProcessWithoutNullStreams;
  send(request: Message): void;
  /** The next message, from the start of this connection, that `match` accepts. */
  next(match: (message: Message) => boolean, ms?: number): Promise<Message>;
  /** Every message so far. */
  messages: Message[];
  /** Each line the runtime wrote that runtime protocol 1 does not allow, with why. */
  invalid: string[];
  stderr(): string;
  /** Ends stdin and waits until the runtime exits. */
  end(): Promise<void>;
}

/** Starts the runtime at `executable` with `env` as its whole environment, and speaks to it over its stdio. */
export function connect(executable: string, env: NodeJS.ProcessEnv): Connection {
  const child = spawn(process.execPath, [executable], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: Message[] = [];
  const invalid: string[] = [];
  const consumed = new Set<Message>();
  let waiters: Array<() => void> = [];
  let stderr = '';
  let closed = false;

  const exited = new Promise<void>((resolve) => child.on('close', () => {
    closed = true;
    resolve();

    for (const wake of waiters) wake();
  }));


  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const raw: unknown = JSON.parse(line);
    const checked = RuntimeMessageSchema.safeParse(raw);

    if (!checked.success) invalid.push(`${line}: ${checked.error.message}`);
    messages.push(MessageSchema.parse(raw));

    for (const wake of waiters) wake();
  });

  return {
    child,
    messages,
    invalid,
    stderr: () => stderr,
    send: (request) => { child.stdin.write(`${JSON.stringify(request)}\n`); },
    next: (match, ms = 10_000) => new Promise((resolve, reject) => {
      const look = (): boolean => {
        const found = messages.find((message) => !consumed.has(message) && match(message));

        if (!found && closed) {
          reject(new Error(`the runtime exited; got ${JSON.stringify(messages)}; stderr: ${stderr}`));

          return true;
        }

        if (!found) return false;
        consumed.add(found);
        resolve(found);

        return true;
      };

      if (look()) return;

      const timer = setTimeout(() => {
        waiters = waiters.filter((waiter) => waiter !== wake);
        reject(new Error(`no matching message in ${ms} ms; got ${JSON.stringify(messages)}; stderr: ${stderr}`));
      }, ms);

      const wake = (): void => {
        if (!look()) return;
        clearTimeout(timer);
        waiters = waiters.filter((waiter) => waiter !== wake);
      };

      waiters.push(wake);
    }),
    end: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

export function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-sandbox-')));
}
