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
import { isAbsolutePath, pathKey, samePath } from './utils/agent-path.js';
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
 * Record what the recall log needs from one PostToolUse: a link when it names
 * the child session a subagent ran in; a claim for each run
 * id a shell call printed, noting whether its command ran `teamai recall`
 * itself; evidence for each file under the knowledge roots it read, or whose
 * lines a search showed, unless it failed; nothing otherwise. Whether a claim or a read of unknown status
 * counts is the reducer's call. The command itself is never recorded.
 */
export async function recordToolCall(stdin: Record<string, unknown>, tool: string, config: LocalConfig): Promise<void> {
  // A subagent's own session, which a bridge names on the call that ran it (OpenCode's task tool).
  const link = stdin.session_link !== null && typeof stdin.session_link === 'object' ? stdin.session_link as Record<string, unknown> : {};
  const child = nonEmpty(link.child);
  const parent = nonEmpty(link.parent);
  if (child && parent && child !== parent) {
    await appendRecallLine(config, { kind: 'link', ts: new Date().toISOString(), child, parent });
  }

  const call = classifyToolCall(stdin, tool);

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

  // A search's paths are the files its output showed lines of; the reducer keeps those a run printed.
  if ((call.category !== 'read' && call.category !== 'search') || call.status === 'failure') return;
  let roots: string[] | undefined;
  for (const file of call.paths) {
    if (isAbsolutePath(file)) {
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
  return pathKey(p).split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * The docs a read of `evidencePath` opened. An absolute path must name the
 * printed one, however either is written (agent-path). A relative path had
 * no base: it matches by its trailing segments (at least the parent and the
 * file name), and only when a single printed path has them.
 */
function docsOpened(evidencePath: string, docs: RecalledDoc[]): RecalledDoc[] {
  if (isAbsolutePath(evidencePath)) return docs.filter((d) => samePath(d.path, evidencePath));
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
 *
 * A subagent that ran in a child session (OpenCode's task tool) is linked to
 * the session that started it: the runs and reads of every session linked up
 * to the same root count as the root's, the ledger's session, whichever of
 * them stopped. The child stays their actor, so a marked run's own reads are
 * still excluded. Links apply whenever they arrived: evidence that did not
 * count before its link is never consumed, so the next Stop re-evaluates it.
 */
export async function creditAdoptedDocs(config: LocalConfig, sessionId: string): Promise<AdoptionResult> {
  const lines = await readRecallLog(config);
  const logged = new Set(lines.flatMap((l) => l.kind === 'run' ? [l.run] : []));
  const claimOf = new Map<string, ClaimLine>();
  const parentOf = new Map<string, string>();
  const consumed = new Set<string>();
  for (const line of lines) {
    if (line.kind === 'claim') {
      if (line.direct !== true || !logged.has(line.run)) continue;
      // Earliest by time: a claim a busy lock left in a side record reads after the file's lines.
      const first = claimOf.get(line.run);
      if (!first || line.ts < first.ts) claimOf.set(line.run, line);
    } else if (line.kind === 'link') {
      if (!parentOf.has(line.child)) parentOf.set(line.child, line.parent);
    } else if (line.kind === 'consumed') consumed.add(line.evidence);
  }
  // The session a child's work counts for: its links followed up to the root. A cycle stops where it closes.
  const rootOf = (session: string): string => {
    const seen = new Set<string>([session]);
    let root = session;
    for (let up = parentOf.get(root); up !== undefined && !seen.has(up); up = parentOf.get(root)) {
      seen.add(up);
      root = up;
    }
    return root;
  };
  const target = rootOf(sessionId);
  const ownerOf = (r: RunLine): string | null => claimOf.get(r.run)?.session ?? (r.unambiguous === true ? r.session : null);
  const runs = lines.filter((l): l is RunLine => {
    if (l.kind !== 'run') return false;
    const owner = ownerOf(l);
    return owner !== null && rootOf(owner) === target;
  });
  // A marked run's actor: the session that ran it, and its claim's subagent there, or the main agent (null).
  const markedActor = new Map<RunLine, { session: string; agentId: string | null }>();
  for (const r of runs) {
    const claim = claimOf.get(r.run);
    if (r.caller === RECALL_SUBAGENT || claim?.agentType === RECALL_SUBAGENT) {
      markedActor.set(r, { session: ownerOf(r)!, agentId: claim?.agentId ?? null });
    }
  }
  const recalled = new Set(runs.flatMap((r) => r.docs.map((d) => d.key))).size;
  if (runs.length === 0) return { credited: [], recalled };

  const keys = new Set<string>();
  const crediting: string[] = [];
  for (const e of lines) {
    if (e.kind !== 'evidence' || consumed.has(e.id) || rootOf(e.session) !== target) continue;
    // A read of unknown status (Codex's shell) counts only as a simple read, never as a pipeline's head.
    if (e.status !== 'success' && !(e.status === 'unknown' && e.simple === true)) continue;
    const at = Date.parse(e.ts);
    const docs = runs
      .filter((r) => { const since = at - Date.parse(r.ts); return since >= 0 && since <= ADOPTION_WINDOW_MS; })
      .filter((r) => {
        const actor = markedActor.get(r);
        return !actor || actor.session !== e.session || actor.agentId !== (e.agentId ?? null);
      })
      .flatMap((r) => r.docs);
    const eligible = docsOpened(e.path, docs).filter((d) => d.eligible);
    if (eligible.length === 0) continue;
    for (const d of eligible) keys.add(d.key);
    crediting.push(e.id);
  }
  if (keys.size === 0) return { credited: [], recalled };

  const { incrementUpvoted } = await import('./votes.js');
  const credited = await incrementUpvoted(path.join(getVotesDir(config), `${config.username}.yaml`), [...keys], target);
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
