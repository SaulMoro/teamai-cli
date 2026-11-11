/**
 * A git that did not start (not installed, not on PATH) answers no question: it exits with no code of its own, so what
 * git() returns must not read as the 0 or 1 an exit-code question answers with.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundedGit } from '../workflow/worktree.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('git when git does not start', () => {
  const later = new Date(Date.now() + 60_000).toISOString();

  it.each([['run to its end', undefined], ['run under a deadline', later]])('returns the code of a command that did not start, %s, never a no', async (_, expiresAt) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-not-started-'));
    roots.push(root);
    const withoutGit = boundedGit(expiresAt, { PATH: root });

    const asked = await withoutGit(root, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD']);

    expect(asked).toMatchObject({ code: 127, stdout: '', stderr: expect.stringContaining('git did not start') });
  });
});
