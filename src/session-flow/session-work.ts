/**
 * A finished agent session as a judge reads it (#1178, #1179): one redacted read gives the evidence of every judge call
 * and the context its labels carry, so `teamai score --session` and a session judge lease build both alike.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  fencedEvidence, keepEnds, rubricPrompt, writeEvidence, EVIDENCE_MAX_CHARS, TOOL_CALL_MAX_CHARS, type EvidenceGap, type Rubrics,
} from '../scorers/evidence.js';
import type { SessionLabel, SessionLabelContext, SessionSubject } from '../scorers/label.js';
import { typedIn, usedSkills } from '../skill-use.js';
import { AgentSession } from './agent-session.js';
import type { SubagentsRead } from './adapters/base.js';
import { SessionCaptures, type SessionCapture } from './captures.js';
import type { Session } from './ir.js';

function transcriptOf(session: Session, budget: number): string {
  const capped: Session = {
    ...session,
    messages: session.messages.map((message) => ({ ...message, content: message.content.map((block) =>
      block.type === 'tool_call' ? { ...block, arguments: { excerpt: keepEnds(JSON.stringify(block.arguments), TOOL_CALL_MAX_CHARS) } } : block) })),
  };
  return keepEnds(AgentSession.transcript(capped).map((entry) => `### ${entry.role}\n${entry.text}\n${entry.toolOutput}`).join('\n\n'), budget);
}

/** A read session's transcript followed by each of its subagents', each kept to its budget, and what of them could not be read. */
export function judgedTranscript(found: { session: Session; subagents?: SubagentsRead }, budget: { session: number; subagent: number }): { body: string; gaps: EvidenceGap[] } {
  const gaps: EvidenceGap[] = [];
  let body = transcriptOf(found.session, budget.session);
  if (found.subagents?.status !== 'read') gaps.push('subagents_unread');
  else for (const agent of found.subagents.agents) {
    if (agent.start === 'unknown') gaps.push('subagent_boundary_unknown');
    body += `\n\n## Subagent (depth ${agent.depth}${agent.finished === false ? ', not finished' : ''})\n\n${transcriptOf(agent.session, budget.subagent)}`;
  }
  return { body, gaps };
}

/**
 * The team skills a session's checkout held as delivered at a message's time: those of the latest capture at or before
 * it. A message with no time takes the ones every capture records alike, else none.
 */
function capturedTeamSkillsAt(captures: readonly SessionCapture[]): (timestamp: string | undefined) => Readonly<Record<string, readonly string[]>> {
  const [first, ...rest] = captures;
  const alike = first !== undefined && rest.every((capture) => isDeepStrictEqual(capture.teamSkills ?? {}, first.teamSkills ?? {}));
  return (timestamp) => {
    const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
    if (Number.isNaN(at)) return alike ? first.teamSkills ?? {} : {};
    const inEffect = captures.filter((capture) => Date.parse(capture.capturedAt) <= at).pop();
    return inEffect?.teamSkills ?? {};
  };
}

function firstPrompt(session: Session): string {
  const text = session.messages.flatMap((message) => message.content.map((block) => typedIn(message, block))).find((typed) => typed !== '') ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** A session as one read gives it to a judge. In memory only: its body is the session's redacted text. */
export interface JudgedSession {
  subject: SessionSubject;
  /** The redacted transcript and its subagents', kept to the evidence cap with the evidence framing. */
  body: string;
  manifest: { subject: SessionSubject; kind: 'session'; gaps: EvidenceGap[] };
  context: SessionLabelContext;
  /** The owning scope's mask: the rubric prompt goes through it too, since a scorer may quote a team secret. */
  mask: (text: string) => string;
}

/**
 * Reads `found` for a judge once: its transcript with its subagents', its first prompt, the agent its captures agree on
 * with the one model its messages name, and the team skills it used, all redacted with `mask`.
 */
export function judgeSession({ platform, found, captures, mask }: {
  platform: string;
  found: { session: Session; subagents?: SubagentsRead };
  captures: readonly SessionCapture[];
  mask: (text: string) => string;
}): JudgedSession {
  const { session } = found;
  const transcript = judgedTranscript(found, { session: Number.POSITIVE_INFINITY, subagent: Number.POSITIVE_INFINITY });
  const subject = { platform, sessionId: session.sessionId };
  const manifest = { subject, kind: 'session' as const, gaps: transcript.gaps };
  const framing = `## evidence.json\n\n${JSON.stringify(manifest)}\n\n## transcripts/session.md\n\n`.length;
  const models = new Set(session.messages.flatMap((message) => message.metadata?.model ?? []));
  const [reportedModel] = models.size === 1 ? models : [];
  const agent = SessionCaptures.agentOf(captures, reportedModel);
  return {
    subject,
    body: keepEnds(mask(transcript.body), EVIDENCE_MAX_CHARS - framing),
    manifest,
    context: {
      ...(agent ? { agent } : {}),
      used: { skills: usedSkills(AgentSession.toolForPlatform(platform), found, capturedTeamSkillsAt(captures)) },
      prompt: mask(firstPrompt(session)),
    },
    mask,
  };
}

/** Writes the evidence of one judge call of `rubrics` on `judged` into `dir`, `.ready` last. */
export async function writeSessionEvidence(dir: string, judged: JudgedSession, rubrics: Rubrics): Promise<void> {
  const { body, manifest, mask } = judged;
  await writeEvidence(dir, async (tmp) => {
    await fs.mkdir(path.join(tmp, 'transcripts'));
    await fs.writeFile(path.join(tmp, 'transcripts', 'session.md'), body);
    await fs.writeFile(path.join(tmp, 'evidence.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(tmp, 'prompt.md'), mask(rubricPrompt(rubrics)) + fencedEvidence([
      { title: 'evidence.json', body: JSON.stringify(manifest) },
      { title: 'transcripts/session.md', body },
    ], 'transcripts/session.md and evidence.json'));
  });
}

/** The label of a verdict on a session, with the context one read of it gave. */
export function sessionLabel(verdict: Omit<SessionLabel, 'source' | 'subject' | 'agent' | 'used'>, subject: SessionSubject, context: SessionLabelContext): SessionLabel {
  const { scorer, rubric, label, score, passed, judge, scoredAt } = verdict;
  return { scorer, rubric, label, score, passed, source: 'session', subject, ...(context.agent ? { agent: context.agent } : {}), used: context.used, judge, scoredAt };
}
