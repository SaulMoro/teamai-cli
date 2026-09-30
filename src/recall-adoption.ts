/**
 * Adoption of recalled docs (#884): a doc counts as adopted when the session
 * that ran a recall opens it within 24 hours after the run.
 *
 *   PostToolUse ── recordToolCall ──▶ claim / evidence ─┐
 *   teamai recall ────────────────▶ run ────────────────┼─▶ recall log
 *   Stop ── creditAdoptedDocs ◀── join ─────────────────┘
 *              └─▶ incrementUpvoted (per-session ledger) ─▶ consumed
 *
 * The hook side only classifies the call and appends one line; it never reads
 * the log. The reducer does the join, at Stop.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { appendRecallLine, readRecallLog } from './recall-log.js';
import type { Actor, ClaimLine, RecalledDoc, RunLine } from './recall-log.js';
import { getVotesDir } from './types.js';
import type { LocalConfig } from './types.js';
import { log } from './utils/logger.js';
import { deriveDispatchSessionId } from './utils/session-id.js';
import { commandWords, simpleCommands } from './utils/shell-command.js';
import { classifyToolCall } from './utils/tool-call.js';

/** How long after a run a read of one of its docs counts as adoption. */
export const ADOPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The run ids recall prints on its region's start line. */
const RUN_ID_PATTERN = /^--- \[teamai:recall:start\] --- \(\d+ results?\) run=([0-9a-f-]{36})(?=\s|$)/gm;

/** The binary's file name; after `npx`, the package, with or without a version. */
const TEAMAI_BINARY = /^teamai(?:\.cmd|\.exe)?$/i;
const TEAMAI_PACKAGE = /^teamai(?:-cli)?(?:@\S*)?$/i;

/** The recall subagent's name: its `--caller`, and the `agent_type` its hooks carry. */
const RECALL_SUBAGENT = 'teamai-recall';

/**
 * Whether a shell command itself runs `teamai recall`: one of its simple
 * commands has `teamai` (by path or `.cmd`/`.exe` too, or the package after
 * `npx`) as its command word, after any `NAME=value` assignments, with
 * `recall` next. A command that only names it inside a quoted argument, such
 * as `codex exec "run teamai recall …"`, does not.
 */
function invokesRecall(command: string): boolean {
  return simpleCommands(command).some((simple) => {
    const words = commandWords(simple.words);
    let i = 0;
    let name = TEAMAI_BINARY;
    if (words[i] === 'npx') {
      i++;
      while (i < words.length && words[i].startsWith('-')) i++;
      name = TEAMAI_PACKAGE;
    }
    return name.test(words[i]?.split(/[\\/]/).pop() ?? '') && words[i + 1] === 'recall';
  });
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** The actor a hook payload names: its session, and the subagent it fired in, if any. */
function actorOf(stdin: Record<string, unknown>, tool: string): Actor {
  const agentId = nonEmpty(stdin.agent_id);
  const agentType = nonEmpty(stdin.agent_type);
  return {
    session: deriveDispatchSessionId(stdin, tool),
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
  };
}

/**
 * Record what the recall log needs from one PostToolUse: a claim for each run
 * id a shell call printed, noting whether its command ran `teamai recall`
 * itself; evidence for each file under the knowledge roots it read, unless it
 * failed; nothing otherwise. Whether a claim or a read of unknown status
 * counts is the reducer's call. The command itself is never recorded.
 */
export async function recordToolCall(stdin: Record<string, unknown>, tool: string, config: LocalConfig): Promise<void> {
  const call = classifyToolCall(stdin);

  if (call.command !== undefined && call.output !== undefined) {
    const runs = [...new Set([...call.output.matchAll(RUN_ID_PATTERN)].map((m) => m[1]))];
    if (runs.length > 0) {
      const actor = actorOf(stdin, tool);
      const direct = invokesRecall(call.command);
      for (const run of runs) {
        await appendRecallLine(config, { kind: 'claim', ts: new Date().toISOString(), run, ...actor, direct });
      }
      return;
    }
  }

  if (call.category !== 'read' || call.status === 'failure') return;
  let roots: string[] | undefined;
  for (const file of call.paths) {
    if (path.isAbsolute(file)) {
      const { knowledgeRoots, isUnderRoots } = await import('./utils/learnings-roots.js');
      roots ??= await knowledgeRoots(config);
      if (!isUnderRoots(file, roots)) continue;
    } else if (!/\.md$/i.test(file)) {
      // No base to place it under a root: only a doc-shaped path is kept, for the suffix match.
      continue;
    }
    await appendRecallLine(config, {
      kind: 'evidence', ts: new Date().toISOString(), id: randomUUID(),
      ...actorOf(stdin, tool), path: file, status: call.status, simple: call.simple,
    });
  }
}

export interface AdoptionResult {
  /** Docs newly upvoted for the session, or null when the votes file was busy and nothing was credited. */
  credited: string[] | null;
  /** Distinct docs the session's runs returned. */
  recalled: number;
}

function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
}

function samePath(a: string, b: string): boolean {
  return segments(a).join('/') === segments(b).join('/') && path.isAbsolute(a) === path.isAbsolute(b);
}

/**
 * The docs a read of `evidencePath` opened. An absolute path must equal the
 * printed one. A relative path had no base: it matches by its trailing
 * segments (at least the parent and the file name), and only when a single
 * printed path has them.
 */
function docsOpened(evidencePath: string, docs: RecalledDoc[]): RecalledDoc[] {
  if (path.isAbsolute(evidencePath)) return docs.filter((d) => samePath(d.path, evidencePath));
  const tail = segments(evidencePath);
  if (tail.length < 2) return [];
  const hits = docs.filter((d) => {
    const segs = segments(d.path);
    return segs.length >= tail.length && tail.every((s, i) => segs[segs.length - tail.length + i] === s);
  });
  return new Set(hits.map((d) => segments(d.path).join('/'))).size === 1 ? hits : [];
}

/**
 * The reducer: credit the docs `sessionId` adopted, through the per-session
 * upvote ledger, and mark the evidence that credited them consumed so it never
 * votes again. Evidence the ledger already credited this session is consumed
 * too. When the votes file is busy nothing is consumed, so the next Stop
 * retries.
 *
 * Each run is settled first: by its first valid claim (one whose command ran
 * the recall itself, for a run in this log, earliest by time), or else by the
 * session its environment named, only when that was the only candidate. A
 * later claim that disagrees is kept but not applied, and an unsettled run
 * never votes. A run the recall subagent made (its `--caller`, or its valid
 * claim's agent type) is marked: reads by the actor that ran it never count
 * for it, while reads by the main agent or any other subagent do. A read
 * whose status the agent did not report counts only when it was the call's
 * only command, of a path one of the session's runs printed. Only eligible
 * docs are credited: an inherited user-scope doc stays read-only while a
 * project is active.
 */
export async function creditAdoptedDocs(config: LocalConfig, sessionId: string): Promise<AdoptionResult> {
  const lines = await readRecallLog(config);
  const logged = new Set(lines.flatMap((l) => l.kind === 'run' ? [l.run] : []));
  const claimOf = new Map<string, ClaimLine>();
  const consumed = new Set<string>();
  for (const line of lines) {
    if (line.kind === 'claim') {
      if (line.direct !== true || !logged.has(line.run)) continue;
      // Earliest by time: a claim a busy lock left in a side record reads after the file's lines.
      const first = claimOf.get(line.run);
      if (!first || line.ts < first.ts) claimOf.set(line.run, line);
    } else if (line.kind === 'consumed') consumed.add(line.evidence);
  }
  const ownerOf = (r: RunLine): string | null => claimOf.get(r.run)?.session ?? (r.unambiguous === true ? r.session : null);
  const runs = lines.filter((l): l is RunLine => l.kind === 'run' && ownerOf(l) === sessionId);
  // A marked run's actor within the session: its claim's subagent, or the main agent (null).
  const markedActor = new Map<RunLine, string | null>();
  for (const r of runs) {
    const claim = claimOf.get(r.run);
    if (r.caller === RECALL_SUBAGENT || claim?.agentType === RECALL_SUBAGENT) markedActor.set(r, claim?.agentId ?? null);
  }
  const recalled = new Set(runs.flatMap((r) => r.docs.map((d) => d.key))).size;
  if (runs.length === 0) return { credited: [], recalled };

  const keys = new Set<string>();
  const crediting: string[] = [];
  for (const e of lines) {
    if (e.kind !== 'evidence' || e.session !== sessionId || consumed.has(e.id)) continue;
    // A read of unknown status (Codex's shell) counts only as a simple read, never as a pipeline's head.
    if (e.status !== 'success' && !(e.status === 'unknown' && e.simple === true)) continue;
    const at = Date.parse(e.ts);
    const docs = runs
      .filter((r) => { const since = at - Date.parse(r.ts); return since >= 0 && since <= ADOPTION_WINDOW_MS; })
      .filter((r) => !markedActor.has(r) || markedActor.get(r) !== (e.agentId ?? null))
      .flatMap((r) => r.docs);
    const eligible = docsOpened(e.path, docs).filter((d) => d.eligible);
    if (eligible.length === 0) continue;
    for (const d of eligible) keys.add(d.key);
    crediting.push(e.id);
  }
  if (keys.size === 0) return { credited: [], recalled };

  const { incrementUpvoted } = await import('./votes.js');
  const credited = await incrementUpvoted(path.join(getVotesDir(config), `${config.username}.yaml`), [...keys], sessionId);
  if (credited === null) return { credited: null, recalled };
  for (const evidence of crediting) {
    try {
      await appendRecallLine(config, { kind: 'consumed', ts: new Date().toISOString(), evidence });
    } catch (e) {
      // The ledger still holds the credit for its window; past it this evidence could credit again.
      log.debug(`recall adoption: could not mark evidence ${evidence} consumed: ${(e as Error).message}`);
    }
  }
  return { credited, recalled };
}
