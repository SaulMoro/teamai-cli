import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleRuntime } from './bundle.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-testing-bundle-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The command lines of this process's children that still run, as the system lists them. A zombie has ended: esbuild's
 * stop kills its service without waiting, and Node reads the exit a moment later.
 */
function childCommands(): string[] {
  const table = execFileSync('ps', ['-A', '-o', 'ppid=,stat=,command='], { encoding: 'utf8' });

  return table.split('\n').flatMap((line) => {
    const [ppid, stat = '', ...command] = line.trim().split(/\s+/);

    return Number(ppid) === process.pid && !stat.startsWith('Z') ? [command.join(' ')] : [];
  });
}

describe('bundleRuntime', () => {
  it('leaves no esbuild process running once the bundle is written', async () => {
    const entry = path.join(dir, 'entry.ts');
    fs.writeFileSync(entry, 'export const answer: number = 42;\n');

    const outfile = await bundleRuntime({ entry, outfile: path.join(dir, 'out.mjs') });

    expect(fs.readFileSync(outfile, 'utf8')).toContain('42');
    expect(childCommands().filter((command) => command.includes('esbuild'))).toEqual([]);
  });

  it('writes every bundle of builds that overlap', async () => {
    const entries = ['one', 'two'].map((name) => {
      const entry = path.join(dir, `${name}.ts`);
      fs.writeFileSync(entry, `export const name: string = '${name}';\n`);

      return { entry, outfile: path.join(dir, `${name}.mjs`) };
    });

    const outfiles = await Promise.all(entries.map((each) => bundleRuntime(each)));

    expect(outfiles.map((outfile) => fs.readFileSync(outfile, 'utf8'))).toEqual([expect.stringContaining('var name = "one"'), expect.stringContaining('var name = "two"')]);
    expect(childCommands().filter((command) => command.includes('esbuild'))).toEqual([]);
  });
});
