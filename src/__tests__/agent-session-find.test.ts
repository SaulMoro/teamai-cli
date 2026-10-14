/**
 * agent-session-find.test.ts — reading the session a caller listed.
 *
 * `find` opens the file the caller listed, not another session with the same id or id suffix,
 * and redacts unless asked not to. Every store lives under a temporary home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '', writeAs: '' }));

// Adapter storage paths come from os.homedir(); replace it so every store is a temp dir.
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

// One id in two workspaces only happens with copies an older TeamAI wrote; writing through the
// adapters under a fixed id plants them.
vi.mock('../session-flow/ids.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../session-flow/ids.js');
  return {
    ...actual,
    deriveTargetSessionId: (target: Parameters<typeof actual.deriveTargetSessionId>[0]) =>
      mocks.writeAs || actual.deriveTargetSessionId(target),
  };
});

import { AgentSession } from '../session-flow/agent-session.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import type { Session } from '../session-flow/ir.js';

const SECRET = 'sk-ABCDEFGH1234567890abcdefghij';

function mkSession(cwd: string, text: string, createdAt = '2026-09-24T10:00:00.000Z'): Session {
  return {
    sessionId: 'source-fixture',
    title: 'find contract',
    cwd,
    platform: 'claude-internal',
    createdAt,
    updatedAt: '2026-09-24T10:00:05.000Z',
    messages: [
      { role: 'user', timestamp: '2026-09-24T10:00:00.000Z', content: [{ type: 'text', text }] },
      { role: 'assistant', timestamp: '2026-09-24T10:00:05.000Z', content: [{ type: 'text', text: 'ok' }] },
    ],
    metadata: {},
  };
}

/** A workspace that exists, spelled the way the file system stores it. */
function workspace(name: string): string {
  const dir = path.join(mocks.home, 'work', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

/**
 * Write a session on `platform` in `cwd` and return the id the adapter gave it. Codex names the
 * rollout file by creation time and id, so two copies of one id need two creation times.
 */
async function plant(platform: string, cwd: string, text: string, id = '', createdAt?: string): Promise<string> {
  mocks.writeAs = id;
  try {
    return await getAdapter(platform).writeSession(mkSession(cwd, text, createdAt), cwd);
  } finally {
    mocks.writeAs = '';
  }
}

const firstText = (session: Session): string => {
  const block = session.messages[0]?.content[0];
  return block?.type === 'text' ? (block.text ?? '') : '';
};

beforeEach(() => {
  mocks.writeAs = '';
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-find-')));
  for (const dir of [
    ['.claude', 'projects'],
    ['.codebuddy', 'projects'],
    ['.codex', 'sessions'],
    ['.cursor', 'projects'],
    ['.workbuddy', 'projects'],
  ]) {
    fs.mkdirSync(path.join(mocks.home, ...dir), { recursive: true });
  }
  process.env.TEAMAI_CODEBUDDY_IDE_DATA = path.join(mocks.home, 'CodeBuddyExtension', 'Data');
  fs.mkdirSync(path.join(process.env.TEAMAI_CODEBUDDY_IDE_DATA, 'ext-x', 'CodeBuddyIDE', 'ext-x', 'history'), {
    recursive: true,
  });
  // Keep Codex's indexing step from starting a real CLI.
  vi.stubEnv('PATH', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.TEAMAI_CODEBUDDY_IDE_DATA;
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('AgentSession.find', () => {
  it('returns the session redacted by default', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('claude-code', cwd, `token ${SECRET}`);

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd });

    expect(found).toMatchObject({ status: 'done', redactedCount: 1 });
    expect(found.status === 'done' && firstText(found.session)).not.toContain(SECRET);
  });

  it('returns the raw session when scrub is false', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('claude-code', cwd, `token ${SECRET}`);

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd }, { scrub: false });

    expect(found.status === 'done' && firstText(found.session)).toBe(`token ${SECRET}`);
    expect(found).not.toHaveProperty('redactedCount');
  });

  it('fails with not_found for a session that does not exist', async () => {
    const ref = { platform: 'claude-code', sessionId: 'no-such-session', cwd: workspace('ws') };

    expect(await AgentSession.find(ref)).toMatchObject({ status: 'failed', failure: { code: 'not_found', ref } });
  });

  // A session the client is writing at that moment must not read as absent.
  it('fails with unreadable for a session that exists but does not parse', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('claude-code', cwd, 'hello');
    const [listed] = await getAdapter('claude-code').listConversations(cwd);
    fs.writeFileSync(listed.filePath!, '{"truncated');

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd });

    expect(found).toMatchObject({ status: 'failed', failure: { code: 'unreadable' } });
  });

  const WRITABLE = ['claude-code', 'codebuddy', 'codebuddy-ide', 'codex', 'cursor', 'workbuddy'] as const;
  const SHARED_ID = '0190a0b0-c0d0-7e0f-8a0b-0c0d0e0f1a2b';

  it.each(WRITABLE)('%s: each listed session is read from the file listed, when one id lives in two workspaces', async (platform) => {
    await plant(platform, workspace('ws-a'), 'in a', SHARED_ID);
    await plant(platform, workspace('ws-b'), 'in b', SHARED_ID, '2026-09-25T10:00:00.000Z');
    const listed = await getAdapter(platform).listConversations();
    expect(listed).toHaveLength(2);

    const texts: string[] = [];
    for (const meta of listed) {
      const found = await AgentSession.find(
        { platform, sessionId: meta.sessionId, filePath: meta.filePath },
        { scrub: false },
      );
      expect(found.status).toBe('done');
      if (found.status === 'done') texts.push(firstText(found.session));
    }

    expect(texts.sort()).toEqual(['in a', 'in b']);
  });

  // A suffix taken as the id would derive another target id than the full id, so a later
  // copy by the full id would duplicate the first.
  it('codex: an id suffix yields the full id of the session opened', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('codex', cwd, 'hello');

    const found = await AgentSession.find({ platform: 'codex', sessionId: sessionId.slice(-12), cwd });

    expect(found.status === 'done' && found.session.sessionId).toBe(sessionId);
  });

  it('codex: reads the copy in the workspace given, when one id lives in two workspaces', async () => {
    await plant('codex', workspace('ws-a'), 'in a', SHARED_ID);
    await plant('codex', workspace('ws-b'), 'in b', SHARED_ID, '2026-09-25T10:00:00.000Z');

    const inA = await AgentSession.find({ platform: 'codex', sessionId: SHARED_ID, cwd: workspace('ws-a') }, { scrub: false });
    const inB = await AgentSession.find({ platform: 'codex', sessionId: SHARED_ID, cwd: workspace('ws-b') }, { scrub: false });

    expect(inA.status === 'done' && firstText(inA.session)).toBe('in a');
    expect(inB.status === 'done' && firstText(inB.session)).toBe('in b');
  });

  it.each(['cursor', 'workbuddy'])('%s: a session outside the workspace given is found by its id', async (platform) => {
    const sessionId = await plant(platform, workspace('ws-a'), 'in a');

    const found = await AgentSession.find({ platform, sessionId, cwd: workspace('ws-b') }, { scrub: false });

    expect(found.status === 'done' && firstText(found.session)).toBe('in a');
  });

  it.each(['claude-code', 'codebuddy', 'codex'])('%s: a session outside the workspace given is not found', async (platform) => {
    const sessionId = await plant(platform, workspace('ws-a'), 'in a');

    const found = await AgentSession.find({ platform, sessionId, cwd: workspace('ws-b') });

    expect(found).toMatchObject({ status: 'failed', failure: { code: 'not_found' } });
  });
});
