/**
 * agent-session-copy.test.ts — the copy contract every writable platform keeps.
 *
 * A copy never overwrites: a target that already exists, under the id this
 * TeamAI derives or one an older TeamAI wrote, is reported as reused and the
 * store is left as it was. Every store lives under a temporary home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
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

// An older TeamAI wrote copies under other ids. Writing through the same adapters under such an
// id plants the copy it left behind.
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
import type { AgentAdapter } from '../session-flow/adapters/base.js';
import type { Session } from '../session-flow/ir.js';
import { installFakeOpencode } from './helpers/fake-opencode.js';

const WRITABLE = ['claude-code', 'codebuddy', 'codebuddy-ide', 'codex', 'cursor', 'opencode', 'workbuddy'] as const;
/** OpenCode keeps its sessions behind its CLI: a stand-in `opencode`, the only command on PATH. */
const FAKE_OPENCODE_BIN = installFakeOpencode();
/** A Claude Code variant with its own store: a source on another platform than every target. */
const SOURCE_PLATFORM = 'claude-internal';
const CAN_REGISTER_CURSOR = process.platform !== 'win32' && spawnSync('sqlite3', ['-version']).status === 0;

function mkSession(cwd: string): Session {
  return {
    sessionId: 'source-fixture',
    title: 'copy contract',
    cwd,
    platform: SOURCE_PLATFORM,
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:05.000Z',
    messages: [
      { role: 'user', timestamp: '2026-09-24T10:00:00.000Z', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', timestamp: '2026-09-24T10:00:05.000Z', content: [{ type: 'text', text: 'hi' }] },
    ],
    metadata: {},
  };
}

function cursorUserDir(): string {
  return process.platform === 'darwin'
    ? path.join(mocks.home, 'Library', 'Application Support', 'Cursor', 'User')
    : path.join(mocks.home, '.config', 'Cursor', 'User');
}

/** A workspace that exists, spelled the way the file system stores it, and known to Cursor. */
function workspace(name: string): string {
  const dir = path.join(mocks.home, 'work', name);
  fs.mkdirSync(dir, { recursive: true });
  const wsDir = path.join(cursorUserDir(), 'workspaceStorage', name);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: `file://${dir}` }));
  return fs.realpathSync.native(dir);
}

/** The real Cursor composer store, so a second copy that touched it would show. */
function createCursorStore(): void {
  const db = path.join(cursorUserDir(), 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const schema = spawnSync('sqlite3', [db], {
    encoding: 'utf-8',
    input:
      'CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);' +
      'CREATE TABLE composerHeaders (composerId TEXT UNIQUE, workspaceId TEXT, createdAt INTEGER,' +
      ' lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER,' +
      ' checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);',
  });
  if (schema.status !== 0) throw new Error(schema.stderr);
}

/** Every file under the home with a hash of its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(mocks.home, { recursive: true }) as string[]) {
    const abs = path.join(mocks.home, rel);
    if (!fs.statSync(abs).isFile()) continue;
    out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
  return out;
}

/** Write the source session and return its id (UUID-shaped). */
async function writeSource(): Promise<string> {
  const cwd = workspace('source');
  return getAdapter(SOURCE_PLATFORM).writeSession(mkSession(cwd), cwd);
}

/** UUIDv7-shaped sha256, the shape every TeamAI release gave derived ids. */
function uuidShaped(key: string): string {
  const hex = crypto.createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8), hex.slice(8, 12), `7${hex.slice(13, 16)}`, `${variant}${hex.slice(17, 20)}`, hex.slice(20, 32)].join(
    '-',
  );
}

/** CodeBuddy IDE stores the id without dashes. */
const bare = (id: string): string => id.replace(/-/g, '');

/**
 * Ids an older TeamAI wrote a copy of a UUID source under: the source id itself on another
 * platform, and for Claude Code and CodeBuddy the derived id without the workspace. No older
 * TeamAI wrote OpenCode sessions.
 */
const LEGACY = [
  ...WRITABLE.filter((platform) => platform !== 'opencode').map((platform) => [platform, 'the source UUID'] as const),
  ['claude-code', 'the id derived without the workspace'] as const,
  ['codebuddy', 'the id derived without the workspace'] as const,
];

function legacyId(platform: string, kind: (typeof LEGACY)[number][1], sourceId: string): string {
  return kind === 'the source UUID' ? sourceId : uuidShaped(`teamai:${platform}:${sourceId}`);
}

beforeEach(() => {
  mocks.writeAs = '';
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-copy-')));
  for (const dir of [
    ['.claude', 'projects'],
    ['.claude-internal', 'projects'],
    ['.codebuddy', 'projects'],
    ['.codex', 'sessions'],
    ['.cursor', 'projects'],
    ['.local', 'share', 'opencode'],
    ['.workbuddy', 'projects'],
  ]) {
    fs.mkdirSync(path.join(mocks.home, ...dir), { recursive: true });
  }
  process.env.TEAMAI_CODEBUDDY_IDE_DATA = path.join(mocks.home, 'CodeBuddyExtension', 'Data');
  fs.mkdirSync(path.join(process.env.TEAMAI_CODEBUDDY_IDE_DATA, 'ext-x', 'CodeBuddyIDE', 'ext-x', 'history'), {
    recursive: true,
  });
  if (CAN_REGISTER_CURSOR) createCursorStore();
  // Keep Codex's indexing step from starting a real CLI.
  vi.stubEnv('PATH', FAKE_OPENCODE_BIN);
  vi.stubEnv('XDG_DATA_HOME', path.join(mocks.home, '.local', 'share'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.TEAMAI_CODEBUDDY_IDE_DATA;
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('AgentSession.copy', () => {
  it.each(WRITABLE)('%s: a second copy is reused and leaves the store unchanged', async (platform) => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };
    const to = { platform, cwd: workspace('target') };

    const first = await AgentSession.copy({ from, to });
    expect(first).toMatchObject({ status: 'done', reused: false });
    // Cursor registered the composer in its real store, so an untouched store proves something.
    if (platform === 'cursor' && CAN_REGISTER_CURSOR) expect(first).not.toHaveProperty('notice');
    const before = snapshot();

    const second = await AgentSession.copy({ from, to });

    expect(second).toMatchObject({ status: 'done', reused: true });
    expect(second.status === 'done' && second.sessionId).toBe(first.status === 'done' && first.sessionId);
    expect(snapshot()).toEqual(before);
  });

  it.each(WRITABLE)('%s: one source copied into two workspaces becomes two sessions', async (platform) => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };

    const inA = await AgentSession.copy({ from, to: { platform, cwd: workspace('ws-a') } });
    const inB = await AgentSession.copy({ from, to: { platform, cwd: workspace('ws-b') } });

    expect(inA).toMatchObject({ status: 'done', reused: false });
    expect(inB).toMatchObject({ status: 'done', reused: false });
    expect(inA.status === 'done' && inA.sessionId).not.toBe(inB.status === 'done' && inB.sessionId);
  });

  it.each(LEGACY)('%s: a copy an older TeamAI wrote under %s is reused', async (platform, kind) => {
    const sourceId = await writeSource();
    const cwd = workspace('target');
    const sourceSession = await getAdapter(SOURCE_PLATFORM).readSession({ sessionId: sourceId, projectPath: workspace('source') });
    mocks.writeAs = legacyId(platform, kind, sourceId);
    await getAdapter(platform).writeSession(sourceSession, cwd);
    mocks.writeAs = '';
    const before = snapshot();

    const result = await AgentSession.copy({
      from: { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') },
      to: { platform, cwd },
    });

    expect(result).toMatchObject({ status: 'done', reused: true });
    expect(result.status === 'done' && bare(result.sessionId)).toBe(bare(legacyId(platform, kind, sourceId)));
    expect(snapshot()).toEqual(before);
  });

  // The legacy ids did not name the workspace, so a copy under one in another workspace belongs there.
  it.each(LEGACY)('%s: a copy an older TeamAI wrote under %s in another workspace is left alone', async (platform, kind) => {
    const sourceId = await writeSource();
    const sourceSession = await getAdapter(SOURCE_PLATFORM).readSession({ sessionId: sourceId, projectPath: workspace('source') });
    mocks.writeAs = legacyId(platform, kind, sourceId);
    await getAdapter(platform).writeSession(sourceSession, workspace('elsewhere'));
    mocks.writeAs = '';

    const result = await AgentSession.copy({
      from: { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') },
      to: { platform, cwd: workspace('target') },
    });

    expect(result).toMatchObject({ status: 'done', reused: false });
    expect(result.status === 'done' && bare(result.sessionId)).not.toBe(bare(legacyId(platform, kind, sourceId)));
    const there = await AgentSession.copy({
      from: { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') },
      to: { platform, cwd: workspace('elsewhere') },
    });
    expect(there.status === 'done' && bare(there.sessionId)).toBe(bare(legacyId(platform, kind, sourceId)));
  });

  // A client writing the copy at that moment, or a damaged file, must not read as absent.
  it.each(WRITABLE)('%s: a copy that no longer parses still counts as existing', async (platform) => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };
    const to = { platform, cwd: workspace('target') };
    const first = await AgentSession.copy({ from, to });
    const id = first.status === 'done' ? bare(first.sessionId) : 'none';
    const copyFiles = Object.keys(snapshot()).filter((rel) => bare(rel).includes(id));
    expect(copyFiles.length).toBeGreaterThan(0);
    for (const rel of copyFiles) fs.writeFileSync(path.join(mocks.home, rel), '{"truncated');
    const before = snapshot();

    const second = await AgentSession.copy({ from, to });

    expect(second).toMatchObject({ status: 'done', reused: true });
    expect(snapshot()).toEqual(before);
  });

  it.each(WRITABLE)('%s: a failed copy removes only the target it created', async (platform) => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };
    const earlier = await AgentSession.copy({ from, to: { platform, cwd: workspace('ws-a') } });
    // The write lands, then the tool fails, the way a crash after a partial write looks.
    const prototype = Object.getPrototypeOf(getAdapter(platform)) as AgentAdapter;
    const write = prototype.writeSession;
    const spy = vi.spyOn(prototype, 'writeSession').mockImplementation(async function (this: AgentAdapter, ...args) {
      await write.apply(this, args);
      throw new Error('disk full');
    });

    const failedCopy = await AgentSession.copy({ from, to: { platform, cwd: workspace('ws-b') } });
    spy.mockRestore();

    expect(failedCopy).toMatchObject({ status: 'failed', failure: { code: 'write_failed', platform } });
    const retried = await AgentSession.copy({ from, to: { platform, cwd: workspace('ws-b') } });
    expect(retried).toMatchObject({ status: 'done', reused: false });
    const again = await AgentSession.copy({ from, to: { platform, cwd: workspace('ws-a') } });
    expect(again).toMatchObject({ status: 'done', reused: true });
    expect(again.status === 'done' && again.sessionId).toBe(earlier.status === 'done' && earlier.sessionId);
  });

  const REFUSED = WRITABLE.flatMap((platform) =>
    ['relative/ws', 'md5:0f1e2d3c', '-Users-me-proj'].map((cwd) => [platform, cwd] as const),
  );
  it.each(REFUSED)('%s: the target workspace "%s" is refused before anything is written', async (platform, cwd) => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };
    const before = snapshot();

    const result = await AgentSession.copy({ from, to: { platform, cwd } });

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'invalid_workspace', cwd } });
    expect(result.status === 'failed' && result.failure.message).toContain(cwd);
    expect(snapshot()).toEqual(before);
  });

  // An old session whose project was deleted still migrates, and the directory is not created.
  const KEEP_ANY_WORKSPACE = WRITABLE.filter((platform) => platform !== 'opencode');
  it.each(KEEP_ANY_WORKSPACE)('%s: a workspace that does not exist gets a copy, and a repeat is reused', async (platform) => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };
    const to = { platform, cwd: path.join(mocks.home, 'work', 'deleted-project') };

    const first = await AgentSession.copy({ from, to });
    expect(first).toMatchObject({ status: 'done', reused: false });
    const before = snapshot();
    const second = await AgentSession.copy({ from, to });

    expect(second).toMatchObject({ status: 'done', reused: true });
    expect(second.status === 'done' && second.sessionId).toBe(first.status === 'done' && first.sessionId);
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(to.cwd)).toBe(false);
  });

  // `opencode session import` refuses a directory that does not exist.
  it('opencode: a workspace that does not exist is refused with its path, and nothing is written', async () => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };
    const to = { platform: 'opencode', cwd: path.join(mocks.home, 'work', 'deleted-project') };
    const before = snapshot();

    const result = await AgentSession.copy({ from, to });

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'write_failed', platform: 'opencode' } });
    expect(result.status === 'failed' && result.failure.message).toContain(to.cwd);
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(to.cwd)).toBe(false);
  });
});

describe('AgentSession.copy into OpenCode', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  function toolSession(cwd: string): Session {
    return {
      ...mkSession(cwd),
      messages: [
        {
          role: 'user',
          timestamp: '2026-09-24T10:00:00.000Z',
          content: [
            { type: 'text', text: 'read notes.txt' },
            { type: 'image', mimeType: 'image/png', data: PNG },
          ],
        },
        {
          role: 'assistant',
          timestamp: '2026-09-24T10:00:01.000Z',
          content: [
            { type: 'thinking', text: 'use the read tool' },
            { type: 'tool_call', toolName: 'read_file', callId: 'call_1', arguments: { path: 'notes.txt' } },
          ],
        },
        {
          role: 'user',
          timestamp: '2026-09-24T10:00:02.000Z',
          content: [{ type: 'tool_result', callId: 'call_1', content: 'hello from notes', isError: false }],
        },
        { role: 'assistant', timestamp: '2026-09-24T10:00:03.000Z', content: [{ type: 'text', text: 'it says hello' }] },
      ],
    };
  }

  it('reads back with its messages in order, under new message ids that sort in that order', async () => {
    const sourceCwd = workspace('source');
    const sourceId = await getAdapter(SOURCE_PLATFORM).writeSession(toolSession(sourceCwd), sourceCwd);
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: sourceCwd };
    const source = await AgentSession.find(from, { scrub: false });

    const copies = [];
    for (const name of ['ws-a', 'ws-b']) {
      const copied = await AgentSession.copy({ from, to: { platform: 'opencode', cwd: workspace(name) } });
      expect(copied).toMatchObject({ status: 'done', reused: false });
      const found = await AgentSession.find(
        { platform: 'opencode', sessionId: copied.status === 'done' ? copied.sessionId : '', cwd: workspace(name) },
        { scrub: false },
      );
      copies.push(found.status === 'done' ? found.session : undefined);
    }

    const turns = (session: Session | undefined) => session?.messages.map(({ role, content }) => ({ role, content }));
    expect(turns(copies[0])).toEqual(turns(source.status === 'done' ? source.session : undefined));
    const ids = copies.map((copy) => [...new Set(copy?.messages.flatMap((m) => (m.messageId ? [m.messageId] : [])))]);
    for (const messageIds of ids) {
      expect(messageIds).toHaveLength(3);
      expect(messageIds.every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id))).toBe(true);
      expect([...messageIds].sort()).toEqual(messageIds);
    }
    expect(ids[0].filter((id) => ids[1].includes(id))).toEqual([]);
  });
});

// Cursor and WorkBuddy list a copy only once the sqlite3 CLI registers it, and Windows ships none.
describe('AgentSession.copy on Windows', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it.each(['cursor', 'workbuddy'])('%s: refused as a target with no_adapter, and nothing is written', async (platform) => {
    const sourceId = await writeSource();
    const from = { platform: SOURCE_PLATFORM, sessionId: sourceId, cwd: workspace('source') };
    const to = { platform, cwd: workspace('target') };
    const before = snapshot();
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const result = await AgentSession.copy({ from, to });

    expect(result).toMatchObject({
      status: 'failed',
      failure: { code: 'no_adapter', platform, reason: 'unsupported on win32' },
    });
    expect(result.status === 'failed' && result.failure.message).toContain('Windows');
    expect(snapshot()).toEqual(before);
  });
});
