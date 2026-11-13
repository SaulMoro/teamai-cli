import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionSince } from './sessions.js';

describe('the session a step thread kept', () => {
  it('is the first one started in the folder since the launch, not a delegated task\'s later one', async () => {
    const toolHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-t3-sessions-')));
    const cwd = path.join(toolHome, 'worktree');
    const dir = path.join(toolHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const write = (sessionId: string, at: string): void => fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId, cwd, timestamp: at, uuid: `${sessionId}-u`, message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', sessionId, cwd, timestamp: at, uuid: `${sessionId}-a`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
    ].join('\n') + '\n');
    const launchedAt = Date.parse('2026-11-06T10:00:00.000Z');
    write('5ab0c71a-0000-4000-8000-000000000001', '2026-11-06T10:00:01.000Z');
    write('dd5bedbf-0000-4000-8000-000000000002', '2026-11-06T10:00:30.000Z');

    try {
      expect(await sessionSince({ driver: 'claudeAgent', toolHome, cwd, since: launchedAt })).toMatchObject({ kind: 'found', session: { id: '5ab0c71a-0000-4000-8000-000000000001' } });
    } finally {
      fs.rmSync(toolHome, { recursive: true, force: true });
    }
  });
});
