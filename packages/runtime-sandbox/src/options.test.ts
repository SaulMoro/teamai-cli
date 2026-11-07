import fs from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundleRuntime, connect, fakeEngine, tempDir, type Connection, type FakeEngine, type Message } from './testing/harness.js';

// The options a definition gives the sandbox runtime, as `init` takes or refuses them, through its stdio entry point.

const IMAGE = 'ghcr.io/acme/agent:1';

let executable: string;
let dir: string;
let engine: FakeEngine;
const open: Connection[] = [];

beforeAll(async () => {
  executable = await bundleRuntime(tempDir());
}, 60_000);

beforeEach(() => {
  dir = tempDir();
  engine = fakeEngine(dir);
  engine.image(IMAGE, { claude: "console.log('2.1.0 (Claude Code)')" });
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  expect(connections.flatMap((connection) => connection.invalid)).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function init(options: Message): Promise<Message> {
  const connection = connect(executable, { ...engine.env(), HOME: dir });
  open.push(connection);
  connection.send({ type: 'init', protocol: 1, mode: 'unattended', options });

  return connection.next((message) => message.type === 'init', 30_000);
}

describe('warm', () => {
  it('takes a prepare command or a containerfile, with the files that key the image, on docker', async () => {
    expect(await init({ provider: 'docker', image: IMAGE, warm: { prepare: 'npm ci --ignore-scripts', cache: ['package.json', 'package-lock.json'] } })).toMatchObject({ ok: true });
    expect(await init({ provider: 'docker', image: IMAGE, warm: { containerfile: 'ci/Containerfile', cache: ['package-lock.json'] } })).toMatchObject({ ok: true });
  });

  it('takes only a prepare command on sbx', async () => {
    expect(await init({ provider: 'sbx', warm: { containerfile: 'ci/Containerfile', cache: ['package-lock.json'] } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm.containerfile' } });
  });

  it('names the key inside warm that is wrong', async () => {
    expect(await init({ provider: 'podman', image: IMAGE, warm: { prepare: 'npm ci', cache: ['package-lock.json'], cahce: [] } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm.cahce' } });
    expect(await init({ provider: 'docker', image: IMAGE, warm: { prepare: 'npm ci' } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm.cache' } });
  });

  it('refuses a prepare command and a containerfile together', async () => {
    const reply = await init({ provider: 'docker', image: IMAGE, warm: { prepare: 'npm ci', containerfile: 'ci/Containerfile', cache: ['package-lock.json'] } });

    expect(reply).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm' } });
  });

  it('is refused on the native sandboxes, which run on this machine\'s own tools', async () => {
    expect(await init({ provider: 'seatbelt', warm: { prepare: 'npm ci', cache: ['package-lock.json'] } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm' } });
  });
});

describe('a key inside an option', () => {
  it('is named with the keys that option takes', async () => {
    const reply = await init({ provider: 'sbx', warm: { prepare: 'npm ci', cache: ['package-lock.json'], expiration: '7d' } });

    expect(reply).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm.expiration', message: 'On provider sbx, warm takes no key "expiration". It takes: prepare, cache' } });
  });
});
