import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * How reading the session `sid` at `filePath`, the path a listing named, from the store `storageRoot` ends in a process
 * of its own, which is stopped after five seconds: a read that blocks the event loop cannot be timed out from inside the
 * process it blocks.
 */
function readInOwnProcess(storageRoot: string, sid: string, filePath: string): Promise<{ stopped: true } | { said: string }> {
  const script = path.join(path.dirname(storageRoot), 'read.mjs');
  fs.writeFileSync(script, `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(path.join(repo, 'scripts', 'typescript-loader.mjs')).href)});
const { ClaudeCodeAdapter } = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'packages', 'tool-core', 'src', 'formats', 'claude-code.ts')).href)});
const adapter = new ClaudeCodeAdapter('claude-code', ${JSON.stringify(storageRoot)});
await adapter.readSession({ sessionId: ${JSON.stringify(sid)}, filePath: ${JSON.stringify(filePath)} }).then(() => console.log('read'), (error) => console.log(error.message));
`);

  return new Promise((resolve) => {
    execFile(process.execPath, [script], { timeout: 5_000 }, (error, stdout) => resolve(error?.killed ? { stopped: true } : { said: stdout.trim() }));
  });
}

describe.skipIf(process.platform === 'win32')('a Claude transcript a step left as something other than a file', () => {
  // A listing names only files, but a step can put a FIFO at a listed path before the transcript is read from it.
  it('fails the read at once when a FIFO stands at the listed transcript path, instead of stalling the process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-fifo-'));
    dirs.push(root);
    const storageRoot = path.join(root, 'projects');
    const sid = '7f9c1a52-0000-4000-8000-000000000001';
    const transcript = path.join(storageRoot, '-home-user-project', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    execFileSync('mkfifo', [transcript]);

    expect(await readInOwnProcess(storageRoot, sid, transcript)).toEqual({ said: `${transcript} is a pipe, not a regular file, so teamai does not read it` });
  });
});
