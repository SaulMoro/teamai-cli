import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn() },
}));

import { MCP_EXCLUDE_START, excludeFromGit, removeMcpGitExclude } from '../mcp-git-exclude.js';

describe('teamai block in .git/info/exclude (#882)', () => {
  let repo: string;
  let excludeFile: string;

  beforeEach(async () => {
    repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-exclude-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    excludeFile = path.join(repo, '.git', 'info', 'exclude');
  });

  afterEach(async () => {
    await fse.remove(repo);
  });

  it('never takes the member\'s lines when a start marker has lost its end marker', async () => {
    await fse.writeFile(excludeFile, `${MCP_EXCLUDE_START}\n/old.json\nscratch/\n`);
    await fse.writeJson(path.join(repo, '.mcp.json'), {});

    await excludeFromGit(path.join(repo, '.mcp.json'));
    expect(await removeMcpGitExclude(excludeFile)).toBe(true);

    expect(await fse.readFile(excludeFile, 'utf8')).toBe(`${MCP_EXCLUDE_START}\n/old.json\nscratch/\n`);
  });
});
