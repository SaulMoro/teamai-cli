/**
 * The recall log of one scope (#884): each `teamai recall` run, and the tool
 * calls that confirm a run or read a file under the knowledge roots, one JSON
 * line each. The adoption reducer joins them at Stop.
 *
 *   run       recall searched: the session from the environment, its caller and the docs it returned
 *   claim     the PostToolUse of the shell call that ran a recall, naming its run and actor
 *   evidence  a PostToolUse read of a file under the knowledge roots, by its actor
 *   consumed  evidence that has been credited, so it never votes again
 *
 * It never holds a query, prompt, tool output or file content. It is local and
 * owner-only, and lives in `dashboard/`, which every data home's `.gitignore`
 * already ignores, so no new ignore entry is needed for it or its side files.
 */
import path from 'node:path';

import { appendJsonl, readJsonl } from './utils/jsonl-store.js';
import { getDataHome, getTeamaiHomeDir } from './types.js';
import type { KnowledgeType, LocalConfig } from './types.js';

/** A doc a run returned, as recall printed it. */
export interface RecalledDoc {
  /** The id its votes are kept under. */
  key: string;
  type?: KnowledgeType;
  /** The scope whose index returned it. */
  scope: 'project' | 'user';
  /** The `File:` path recall printed. */
  path: string;
  score: number;
  /** False for an inherited user-scope doc while a project is active: it stays read-only. */
  eligible: boolean;
}

/**
 * Who made a tool call: a session, and within it the subagent the hook fired
 * in. No `agentId` means the session's main agent.
 */
export interface Actor {
  session: string;
  /** The hook's `agent_id`: present only inside a subagent. */
  agentId?: string;
  /** The hook's `agent_type`: for a custom subagent, its agent file's `name`. */
  agentType?: string;
}

export interface RunLine {
  kind: 'run';
  ts: string;
  run: string;
  /**
   * The agent session recall read from its environment, or null when none was
   * set. The environment names no subagent, so the run's own actor is that
   * session's main agent; its claim names the actor that ran it.
   */
  session: string | null;
  /** `--caller`: `teamai-recall` when the recall subagent ran it. */
  caller?: string;
  docs: RecalledDoc[];
}

export interface ClaimLine extends Actor {
  kind: 'claim';
  ts: string;
  run: string;
}

export interface EvidenceLine extends Actor {
  kind: 'evidence';
  ts: string;
  id: string;
  /** Absolute once resolved against the call's cwd; relative when the call had no cwd. */
  path: string;
  status: 'success';
}

export interface ConsumedLine {
  kind: 'consumed';
  ts: string;
  /** The id of the evidence that was credited. */
  evidence: string;
}

export type RecallLogLine = RunLine | ClaimLine | EvidenceLine | ConsumedLine;

const KINDS = new Set<string>(['run', 'claim', 'evidence', 'consumed']);

/**
 * The recall log of the scope `config` names, beside its votes: a historical
 * project-scoped config with no project root records into the user scope's, as
 * its votes do (getVotesDir).
 */
export function recallLogPath(config: LocalConfig): string {
  const home = !config.dataHome && config.scope === 'project' && !config.projectRoot
    ? getTeamaiHomeDir()
    : getDataHome(config);
  return path.join(home, 'dashboard', 'recall.jsonl');
}

/** Append one line. Throws on I/O errors; the caller decides what a lost line costs. */
export async function appendRecallLine(config: LocalConfig, line: RecallLogLine): Promise<void> {
  await appendJsonl(recallLogPath(config), line);
}

/** Every line of the scope's log, those a busy lock left in side records included. */
export async function readRecallLog(config: LocalConfig): Promise<RecallLogLine[]> {
  const records = await readJsonl(recallLogPath(config));
  return records.filter((r): r is RecallLogLine & Record<string, unknown> => typeof r.kind === 'string' && KINDS.has(r.kind));
}
