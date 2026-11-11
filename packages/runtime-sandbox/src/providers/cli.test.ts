import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../testing/harness.js';
import { cliOf } from './cli.js';

// An engine CLI's run: how much of a command's output the runtime keeps.

const PRINTED = 200_000;
let dir: string;

beforeEach(() => {
  dir = tempDir();
  // Prints PRINTED characters, the last three END.
  fs.writeFileSync(path.join(dir, 'chatty'), `#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write("x".repeat(${PRINTED - 3}) + "END")'\n`, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const cli = () => cliOf({ name: 'chatty', env: { PATH: `${dir}${path.delimiter}/usr/bin${path.delimiter}/bin` }, notInstalled: 'chatty is not installed' });

describe('cliOf: run', () => {
  it("keeps only the last 64 Ki characters of a command that is not a listing, such as a warm image's prepare", async () => {
    const ran = await cli().run(['prepare']);

    expect(ran.kind).toBe('ran');
    const stdout = ran.kind === 'ran' ? ran.stdout : '';

    expect(stdout).toHaveLength(64 * 1024);
    expect(stdout.endsWith('END')).toBe(true);
  });

  it('keeps the whole answer of a listing, which its caller parses', async () => {
    const ran = await cli().run(['ls', '--json'], { isListing: true });

    expect(ran.kind === 'ran' ? ran.stdout.length : 0).toBe(PRINTED);
  });
});
