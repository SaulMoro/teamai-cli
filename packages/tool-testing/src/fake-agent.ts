import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** The tools a fake agent stands in for: each prints the call output its family recorded from the real CLI. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, as LAUNCH_ADAPTERS is; only these have a recorded call and stand-in
export const FAKE_AGENT_TOOLS = ['claude', 'opencode'] as const;

export type FakeAgentTool = (typeof FAKE_AGENT_TOOLS)[number];

/** What the prompt or the options ask a fake agent to do beyond answering. */
export const FAKE_AGENT_MARKERS = {
  /** Prints its first line (Claude's init, when it streams), then goes silent until killed. */
  hang: '[[fake:hang]]',
  /** Waits `slowMs` before each line it prints. */
  slow: '[[fake:slow]]',
  /** Prints the recorded failure and exits non-zero. */
  fail: '[[fake:fail]]',
  /** Also writes a subagent transcript where Claude Code keeps them. */
  subagent: '[[fake:subagent]]',
  /** Commits a file holding the prompt in its cwd before it answers. */
  commit: '[[fake:commit]]',
} as const;

export type FakeAgentBehaviour = keyof typeof FAKE_AGENT_MARKERS;

export interface FakeAgentOptions {
  /** The directory the executable goes in, which the test puts on PATH. Keep it short: macOS caps a path at 1024 bytes. */
  readonly bin: string;
  /** The reply text, where the recorded answer was. Default: the recorded answer. */
  readonly answer?: string;
  /** The first entry whose `when` the prompt contains gives the reply instead of `answer`. */
  readonly answers?: ReadonlyArray<{ readonly when: string; readonly answer: string }>;
  /** Behaviours on every call, as though each prompt held their markers. */
  readonly always?: readonly FakeAgentBehaviour[];
  /** How long `slow` waits before each line. Default 600 ms. */
  readonly slowMs?: number;
  /**
   * JavaScript the fake runs once it read the prompt, before it answers, with `prompt`, `args`, `fs`, `path` and a
   * mutable `reply` in scope. It may exit on its own, print, or change `reply`.
   */
  readonly before?: string;
}

const Call = z.object({ args: z.array(z.string()), prompt: z.string(), cwd: z.string() });

export type FakeAgentCall = z.infer<typeof Call>;

export interface FakeAgent {
  /** The executable, `<bin>/<tool>`. */
  readonly executable: string;
  /** Every call so far, in order: its arguments, the prompt it read on stdin, and its cwd. */
  calls(): FakeAgentCall[];
}

const PACKAGES = new URL('../../', import.meta.url);

function recorded(file: string): string {
  return fs.readFileSync(new URL(file, PACKAGES), 'utf8').trim();
}

/** What a tool printed for real: the version it answers, an answered and a failed call, and the transcript it kept. */
interface Recording {
  readonly version: string;
  readonly answered: string;
  readonly failed: string;
  readonly transcript?: string;
}

function recordingOf(tool: FakeAgentTool): Recording {
  switch (tool) {
    case 'claude':
      return {
        version: '2.1.199 (Claude Code)',
        answered: recorded('tool-claude/src/fixtures/claude-call-answered.json'),
        failed: recorded('tool-claude/src/fixtures/claude-call-failed.json'),
        transcript: recorded('tool-claude/src/fixtures/claude-code-transcript.jsonl'),
      };
    case 'opencode':
      return {
        version: 'opencode v2.0.29',
        answered: recorded('tool-opencode/src/fixtures/opencode-run-answered.jsonl'),
        failed: recorded('tool-opencode/src/fixtures/opencode-run-failed.jsonl'),
      };
    default: {
      const unhandled: never = tool;

      throw new Error(`No recording for ${String(unhandled)}`);
    }
  }
}

/**
 * A stand-in `claude` or `opencode` in `bin` that prints what the real CLI printed in the family's recorded call, with
 * only the reply and the session id swapped, and writes its session where the real one does. Prompt markers
 * (`FAKE_AGENT_MARKERS`) make it hang, go slow, fail, start a subagent or commit. POSIX only.
 */
export function fakeAgent(tool: FakeAgentTool, options: FakeAgentOptions): FakeAgent {
  const executable = path.join(options.bin, tool);
  const log = path.join(options.bin, `${tool}.calls.jsonl`);

  const settings = {
    tool,
    log,
    recording: recordingOf(tool),
    markers: FAKE_AGENT_MARKERS,
    answer: options.answer,
    answers: options.answers ?? [],
    always: options.always ?? [],
    slowMs: options.slowMs ?? 600,
  };

  fs.mkdirSync(options.bin, { recursive: true });
  fs.writeFileSync(executable, `#!${process.execPath}\nconst settings = ${JSON.stringify(settings)};\n${AGENT.replace('/* before */', options.before ?? '')}`, { mode: 0o755 });

  return {
    executable,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => Call.parse(JSON.parse(line))) : []),
  };
}

const AGENT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const { tool, recording } = settings;
if (args.includes('--version')) { process.stdout.write(recording.version + '\n'); process.exit(0); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  fs.appendFileSync(settings.log, JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\n');
  const does = (behaviour) => settings.always.includes(behaviour) || prompt.includes(settings.markers[behaviour]);
  const picked = settings.answers.find((entry) => prompt.includes(entry.when));
  let reply = picked ? picked.answer : settings.answer;
  /* before */
  const sessionId = tool === 'claude' ? randomUUID() : 'ses_' + randomUUID().replaceAll('-', '').slice(0, 26);
  const say = async (line) => { if (does('slow')) await sleep(settings.slowMs); process.stdout.write(line + '\n'); };
  if (does('commit')) {
    fs.writeFileSync('agent.txt', prompt + '\n');
    execFileSync('git', ['add', 'agent.txt']);
    execFileSync('git', ['commit', '-qm', 'agent commit']);
  }
  if (tool === 'claude') {
    const streams = args.includes('stream-json') || args.includes('--output-format=stream-json');
    const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'claude-sonnet-4-5';
    if (streams) await say(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd() }));
    if (does('hang')) { setInterval(() => {}, 1 << 30); return; }
    if (does('fail')) {
      await say(JSON.stringify({ ...JSON.parse(recording.failed), session_id: sessionId }));
      process.exit(1);
    }
    const result = JSON.parse(recording.answered);
    if (reply !== undefined) result.result = reply;
    result.session_id = sessionId;
    if (args.includes('--json-schema')) { try { result.structured_output = JSON.parse(result.result); } catch {} }
    if (streams) await say(JSON.stringify({ type: 'assistant', session_id: sessionId, message: { model, content: [{ type: 'text', text: result.result }] } }));
    if (!args.includes('--no-session-persistence')) writeClaudeSession(sessionId, does('subagent'));
    await say(JSON.stringify(result));
    process.exit(0);
  }
  const events = (does('fail') ? recording.failed : recording.answered).split('\n').map((line) => JSON.parse(line));
  for (const [index, event] of events.entries()) {
    event.sessionID = sessionId;
    if (event.type === 'text' && reply !== undefined) event.part.text = reply;
    await say(JSON.stringify(event));
    if (index === 0 && does('hang')) { setInterval(() => {}, 1 << 30); return; }
  }
  process.exit(does('fail') ? 1 : 0);
});

/** Claude Code's project directory name: the cwd with every other character as -, cut at 200 with its hash. */
function claudeProjectDir(cwd) {
  const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let at = 0; at < cwd.length; at++) hash = (Math.imul(31, hash) + cwd.charCodeAt(at)) | 0;
  return encoded.slice(0, 200) + '-' + Math.abs(hash).toString(36);
}

function writeClaudeSession(sessionId, subagent) {
  const cwd = fs.realpathSync(process.cwd());
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
  const project = path.join(home, 'projects', claudeProjectDir(cwd));
  const fill = (text) => text.replaceAll('{{cwd}}', cwd).replaceAll('{{sessionId}}', sessionId);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, sessionId + '.jsonl'), fill(recording.transcript) + '\n');
  if (!subagent) return;
  const agents = path.join(project, sessionId, 'subagents');
  fs.mkdirSync(agents, { recursive: true });
  const first = JSON.parse(fill(recording.transcript.split('\n')[0]));
  fs.writeFileSync(path.join(agents, 'agent-a1.jsonl'), JSON.stringify({ ...first, isSidechain: true, agentId: 'a1' }) + '\n');
}
`;
