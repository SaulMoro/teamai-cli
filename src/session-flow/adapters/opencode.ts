/**
 * adapters/opencode.ts — OpenCode platform adapter.
 *
 * OpenCode 2 keeps sessions in a SQLite store whose schema is still moving, so this adapter talks
 * only to its CLI: `opencode session list --format json` (the sessions of the project the command
 * runs in), `opencode session export <id>` (one session by id, from any directory) and
 * `opencode session delete <id>`. OpenCode 1 has no `session export`, so it counts as unavailable.
 *
 * Every call passes `--standalone`: without it the CLI talks to OpenCode's background service,
 * and starts one when none runs, which outlives this process.
 *
 * Export shape (OpenCode 2.0.29): `{ info, messages }`. `info` carries `id`, `title`,
 * `time.created/updated` (epoch ms) and `location.directory`. A `user` message has `text` and
 * `files` (inline base64 with `mime` and `name`); an `assistant` message has `content` parts:
 * `text`, `reasoning`, and `tool` (`id` is the call id, `state.input`, `state.content` the
 * result). Other message types (`idle`, `synthetic`, `system`, `shell`, `skill`, `compaction`)
 * are bookkeeping and are not read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from './base.js';
import type { ContentBlock, Message, Session } from '../ir.js';
import { resolveRealCwd } from '../fs.js';
import { execCommand, probeBinary, type ExecResult } from '../../utils/exec.js';

const OPENCODE_TO_IR_TOOL: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  shell: 'bash',
  bash: 'bash',
  glob: 'glob',
  grep: 'grep',
  task: 'task',
  todowrite: 'todo_write',
  webfetch: 'web_fetch',
  websearch: 'web_search',
};

/** How many sessions one listing returns; the CLI's own default is 100. */
const LIST_MAX = 10_000;

/** `opencode session export` and `delete` print this to stderr for an id it does not have. */
const NOT_FOUND = /Session not found/i;

const ListedSessions = z.array(
  z.object({ id: z.string(), title: z.string(), created: z.number(), updated: z.number(), directory: z.string() }),
);

const ExportedSession = z.object({
  info: z.object({
    id: z.string(),
    title: z.string(),
    time: z.object({ created: z.number(), updated: z.number() }),
    location: z.object({ directory: z.string() }),
    model: z.object({ id: z.string() }).optional(),
  }),
  messages: z.array(z.object({ type: z.string() }).passthrough()),
});

const MessageTime = z.object({ created: z.number() });

const UserMessage = z.object({
  id: z.string(),
  time: MessageTime,
  text: z.string().default(''),
  files: z
    .array(z.object({ mime: z.string(), data: z.string().optional(), name: z.string().optional(), uri: z.string().optional() }))
    .default([]),
});

const AssistantMessage = z.object({
  id: z.string(),
  time: MessageTime,
  content: z.array(z.object({ type: z.string() }).passthrough()),
});

const ToolPart = z.object({
  id: z.string(),
  name: z.string(),
  state: z.object({
    status: z.string(),
    input: z.record(z.unknown()).default({}),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
    error: z.unknown().optional(),
  }),
});

const TextPart = z.object({ text: z.string() });

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

function userContent(message: z.infer<typeof UserMessage>): ContentBlock[] {
  const content: ContentBlock[] = message.text ? [{ type: 'text', text: message.text }] : [];
  for (const file of message.files) {
    if (file.mime.startsWith('image/') && file.data) {
      content.push({ type: 'image', mimeType: file.mime, data: file.data, ...(file.name ? { label: file.name } : {}) });
    } else {
      content.push({ type: 'text', text: `[file: ${file.name ?? file.uri ?? file.mime}]` });
    }
  }
  return content;
}

function toolResultText(state: z.infer<typeof ToolPart>['state']): string {
  const text = state.content.map((c) => c.text ?? '').join('');
  if (text || state.error === undefined) return text;
  const error = state.error as { message?: unknown };
  return typeof error?.message === 'string' ? error.message : JSON.stringify(state.error);
}

/**
 * An assistant message becomes IR turns: its text, reasoning and tool calls, then a user
 * message with the tool results, as Claude Code and Codex store them; text after a tool call
 * opens the next assistant turn.
 */
function assistantTurns(message: z.infer<typeof AssistantMessage>): Message[] {
  const timestamp = iso(message.time.created);
  const turns: Message[] = [];
  let assistant: ContentBlock[] = [];
  let results: ContentBlock[] = [];
  const flush = () => {
    if (assistant.length > 0) turns.push({ role: 'assistant', content: assistant, timestamp, messageId: message.id });
    if (results.length > 0) turns.push({ role: 'user', content: results, timestamp });
    assistant = [];
    results = [];
  };
  for (const part of message.content) {
    if (part.type === 'tool') {
      const tool = ToolPart.parse(part);
      assistant.push({
        type: 'tool_call',
        toolName: OPENCODE_TO_IR_TOOL[tool.name] ?? tool.name,
        callId: tool.id,
        arguments: tool.state.input,
      });
      results.push({
        type: 'tool_result',
        callId: tool.id,
        content: toolResultText(tool.state),
        isError: tool.state.status !== 'completed',
      });
      continue;
    }
    if (part.type !== 'text' && part.type !== 'reasoning') continue;
    if (results.length > 0) flush();
    const { text } = TextPart.parse(part);
    assistant.push(part.type === 'text' ? { type: 'text', text } : { type: 'thinking', text });
  }
  flush();
  return turns;
}

function sessionFromExport(stdout: string): Session {
  const exported = ExportedSession.parse(JSON.parse(stdout));
  const messages: Message[] = [];
  for (const message of exported.messages) {
    if (message.type === 'user') {
      const user = UserMessage.parse(message);
      messages.push({ role: 'user', content: userContent(user), timestamp: iso(user.time.created), messageId: user.id });
    } else if (message.type === 'assistant') {
      messages.push(...assistantTurns(AssistantMessage.parse(message)));
    }
  }
  const { info } = exported;
  return {
    sessionId: info.id,
    title: info.title,
    cwd: info.location.directory,
    platform: 'opencode',
    createdAt: iso(info.time.created),
    updatedAt: iso(info.time.updated),
    messages,
    metadata: info.model ? { model: info.model.id } : {},
  };
}

export class OpencodeAdapter extends AgentAdapter {
  static readonly platform = 'opencode';

  get platform(): string {
    return 'opencode';
  }

  /** OpenCode's data directory: `$XDG_DATA_HOME/opencode`, `~/.local/share/opencode` by default. */
  static getDefaultStoragePath(): string {
    return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'opencode');
  }

  isReady(): boolean {
    return fs.existsSync(OpencodeAdapter.getDefaultStoragePath());
  }

  /** Run an `opencode session` command; throws `ToolUnavailableError` when no OpenCode 2 runs here. */
  private async session(args: string[], cwd?: string): Promise<ExecResult> {
    const version = await probeBinary('opencode');
    const major = /(\d+)\.\d+/.exec(version)?.[1];
    if (!major || Number(major) < 2) {
      throw new ToolUnavailableError(
        version
          ? `OpenCode ${version} has no \`opencode session export\`. Upgrade OpenCode to version 2 or later.`
          : 'The opencode CLI was not found on PATH. Install OpenCode 2 or later.',
      );
    }
    return execCommand('opencode', ['session', ...args, '--standalone'], { cwd });
  }

  /**
   * The sessions of the project `projectPath` is in, newest first. The CLI lists one project at
   * a time, so without `projectPath` this lists the project the command runs in.
   */
  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const cwd = projectPath ?? process.cwd();
    if (!fs.existsSync(cwd)) return [];
    const result = await this.session(['list', '--format', 'json', '--max-count', String(LIST_MAX)], cwd);
    if (result.code !== 0) throw new Error(`opencode session list failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return ListedSessions.parse(JSON.parse(result.stdout)).map((listed) => ({
      sessionId: listed.id,
      title: listed.title,
      cwd: listed.directory,
      platform: 'opencode',
      createdAt: iso(listed.created),
      updatedAt: iso(listed.updated),
      // The listing carries no message count or size; exporting each session to count is too slow.
      messageCount: 0,
      sizeBytes: 0,
    }));
  }

  /** A session id names one OpenCode session in every project, so `projectPath` and `filePath` are not needed. */
  async readSession(ref: SessionReadRef): Promise<Session> {
    const result = await this.session(['export', ref.sessionId]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `opencode session export exited ${result.code}`);
    return sessionFromExport(result.stdout);
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    if (!sessionId.startsWith('ses_')) return undefined;
    const result = await this.session(['export', sessionId]);
    // Any other failure leaves the session's existence unknown, so it counts as existing.
    if (result.code !== 0) return NOT_FOUND.test(result.stderr) ? undefined : sessionId;
    if (!projectPath) return sessionId;
    let directory: string;
    try {
      directory = ExportedSession.parse(JSON.parse(result.stdout)).info.location.directory;
    } catch {
      return sessionId;
    }
    return resolveRealCwd(directory) === resolveRealCwd(projectPath) ? sessionId : undefined;
  }

  async writeSession(): Promise<string> {
    throw new Error('Writing OpenCode sessions is not supported yet. Pick another target platform.');
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    if (!(await this.existingSessionId(sessionId, projectPath))) return false;
    const result = await this.session(['delete', sessionId]);
    if (result.code === 0) return true;
    if (NOT_FOUND.test(result.stderr)) return false;
    throw new Error(`opencode session delete ${sessionId} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}
