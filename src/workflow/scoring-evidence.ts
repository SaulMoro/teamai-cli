import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentSession } from '../session-flow/agent-session.js';
import { judgedTranscript } from '../session-flow/session-work.js';
import { knownSecrets } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { redact } from '../utils/redact.js';
import { scoresDir } from '../scorers/attempts.js';
import {
  fencedEvidence, isEvidenceReady, rubricPrompt, subjectEvidenceDirOf, writeEvidence, SESSION_MAX_CHARS, SUBAGENT_MAX_CHARS, type EvidenceGap, type Rubrics,
} from '../scorers/evidence.js';
import type { RunSubject } from '../scorers/label.js';
import { firstSettled, isUnder, passRange, passesWithin, runPasses, type RunPass } from './loop.js';
import { stepDefinitions } from './scope.js';
import { agentPassOf, type StepPass } from './step-state.js';
import type { RunState } from './types.js';
import { branchName } from './workspace.js';
import { stepCheckout, UNTRUSTED_CONFIG } from './worktree.js';

const exec = promisify(execFile);
type Range = { branch: string; from: string; to: string; source: 'changes' | 'read' | 'copy' };

function ranIn(run: RunState, pass: StepPass): string | undefined {
  const branch = pass.changes?.branch ?? pass.read?.branch;
  const owner = branch === undefined ? undefined : run.copies?.[branch]?.owner;
  return branch !== undefined && owner?.kind === 'local' ? stepCheckout(owner.workspace, branch) : run.checkout;
}

/** `settling` is the subject's own pass as a report about to settle it holds it, before the run does. */
export function evidencePlan(run: RunState, subject: RunSubject, settling?: RunPass) {
  const definitionOf = stepDefinitions(run);
  const all = runPasses(run, agentPassOf);
  const own = settling ?? all.find((pass) => pass.step === subject.step && pass.pass === subject.pass);
  const workflow = definitionOf(subject.step)?.workflow !== undefined;
  const gaps: EvidenceGap[] = [];
  const under = isUnder(subject.step);
  if (workflow && (run.archive ?? []).some((pass) => under(pass.step) && !pass.within)) gaps.push('children_unattributed');
  const passes = workflow
    ? passesWithin(run, all, subject.step, subject.pass).filter((pass) => definitionOf(pass.step)?.workflow === undefined)
    : own ? [own] : [];
  let diff: Range | undefined = own && passRange(own);
  if (workflow) {
    const branch = branchName(run.id, subject.step, subject.pass);
    const copy = run.copies?.[branch];
    const settled = firstSettled(passes.filter((pass) => passRange(pass) !== undefined));
    const first = settled && passRange(settled);
    if (copy?.commit && first) diff = { branch, from: first.from, to: copy.commit, source: 'copy' };
  }
  const ranges = passes.flatMap((pass): Array<Range & { step: string; pass: number }> => {
    const range = passRange(pass);
    return range ? [{ step: pass.step, pass: pass.pass, ...range }] : [];
  });
  if (diff?.source === 'copy') ranges.unshift({ step: subject.step, pass: subject.pass, ...diff });
  if (!diff && ranges.length === 0) gaps.push('no_recorded_range');
  return { subject, kind: workflow ? 'workflow' : 'prompt', checkout: run.checkout, diff, repoAt: diff?.to ?? ranges.at(-1)?.to, passes, ranges, gaps };
}

/** The environment git gets in the checkout evidence is read from, and the settings it starts with there. */
interface GitIn { env: NodeJS.ProcessEnv; config: readonly string[] }

async function git(checkout: string, args: string[], { env, config }: GitIn): Promise<string> {
  return (await exec('git', [...config, ...args], { cwd: checkout, env, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })).stdout;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** `blob` as text, or undefined when it is not UTF-8 text, so it cannot be redacted. */
function textOf(blob: Buffer): string | undefined {
  if (blob.includes(0)) return undefined;
  try {
    return utf8.decode(blob);
  } catch {
    return undefined;
  }
}

/** Writes the tracked files at `commit` into `dir`, redacted; a file that is not text is left out and named in `omitted`. */
async function exportRepo(checkout: string, gitIn: GitIn, commit: string, dir: string, omitted: string[], mask: (text: string) => string): Promise<Array<{ title: string; body: string }>> {
  const files = (await git(checkout, ['ls-tree', '-rz', '--full-tree', commit], gitIn)).split('\0');
  const sections: Array<{ title: string; body: string }> = [];
  for (const file of files) {
    if (!file) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(file);
    if (!match) continue;
    const [, , type, oid, name] = match;
    if (type !== 'blob' || !oid || !name) continue;
    const target = path.resolve(dir, name);
    if (!target.startsWith(`${dir}${path.sep}`)) throw new Error(`Unsafe tracked path: ${name}`);
    const blob = await exec('git', [...gitIn.config, 'cat-file', 'blob', oid], { cwd: checkout, env: gitIn.env, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
    const text = textOf(blob.stdout);
    if (text === undefined) {
      omitted.push(`repo/${name}`);
      continue;
    }
    const body = mask(text);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    sections.push({ title: `repo/${name}`, body });
  }
  return sections;
}

/** The fenced block a judge prompt quotes the evidence in, kept beside the files so a prompt can be assembled for any rubrics. */
const FENCED = '.fenced.md';

/** Redacts secret shapes, secret-named env values, and the values of the secrets the team declares. */
async function secretMask(config: LocalConfig): Promise<(text: string) => string> {
  const envSecrets = await knownSecrets(config);
  return (text) => redact(text, { envSecrets });
}

/**
 * Writes a subject's evidence into `dir` without any rubric: diff.patch, repo/, transcripts/, outputs.json and
 * evidence.json, and the fenced block a prompt quotes them in, all at once through writeEvidence. `source` names the
 * checkout and the session cwd to read; without it, the run's own are read. A checkout another process controls comes
 * with `untrustedEnv`, the whole environment git gets there, and git starts with UNTRUSTED_CONFIG. A report that
 * collects the evidence before the engine settles its pass gives that pass as `settling`. A directory already filled is
 * kept.
 */
export async function collectEvidence(
  config: LocalConfig,
  run: RunState,
  subject: RunSubject,
  dir: string,
  source?: { checkout: string; sessionCwd: string; untrustedEnv?: NodeJS.ProcessEnv; settling?: RunPass },
): Promise<{ ok: true } | { ok: false; code: 'evidence_empty' }> {
  // A directory an older teamai filled has no fenced block, so it is collected again.
  if (await isEvidenceReady(dir) && await fs.access(path.join(dir, FENCED)).then(() => true, () => false)) return { ok: true };
  const mask = await secretMask(config);
  const plan = evidencePlan(run, subject, source?.settling);
  const checkout = source?.checkout ?? plan.checkout;
  const gitIn: GitIn = source?.untrustedEnv ? { env: source.untrustedEnv, config: UNTRUSTED_CONFIG } : { env: process.env, config: [] };
  const gaps = new Set(plan.gaps);
  const sections: Array<{ title: string; body: string }> = [];
  const omitted: string[] = [];
  let content = false;
  await writeEvidence(dir, async (tmp) => {
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(repo);
    if (checkout) {
      try {
        const ranges = plan.diff ? [plan.diff] : plan.ranges;
        const patch = (await Promise.all(ranges.map((range) => git(checkout, ['diff', '--no-ext-diff', '--no-textconv', range.from, range.to, '--'], gitIn)))).join('\n');
        if (ranges.length > 0) {
          const body = mask(patch);
          await fs.writeFile(path.join(tmp, 'diff.patch'), body);
          sections.push({ title: 'diff.patch (may include merged dependencies)', body });
          content = true;
        }
        if (plan.repoAt) sections.push(...await exportRepo(checkout, gitIn, plan.repoAt, repo, omitted, mask));
      } catch {
        gaps.add('commit_missing');
      }
    } else if (plan.repoAt) gaps.add('no_checkout');
    const outputs: Record<string, unknown> = {};
    for (const pass of plan.passes) {
      const name = `${pass.step}#${pass.pass}`;
      if (pass.outputs !== undefined) { outputs[name] = pass.outputs; content = true; }
      const platform = pass.tool && AgentSession.platformForTool(pass.tool);
      if (!pass.session || !platform) { gaps.add('transcript_not_found'); continue; }
      const found = await AgentSession.find({ platform, sessionId: pass.session, cwd: source?.sessionCwd ?? ranIn(run, pass) }, { subagents: true });
      if (found.status !== 'done') { gaps.add('transcript_not_found'); continue; }
      content = true;
      const judged = judgedTranscript(found, { session: SESSION_MAX_CHARS, subagent: SUBAGENT_MAX_CHARS });
      for (const gap of judged.gaps) gaps.add(gap);
      await fs.mkdir(path.join(tmp, 'transcripts'), { recursive: true });
      const body = mask(judged.body);
      await fs.writeFile(path.join(tmp, 'transcripts', `${name}.md`), body);
      sections.push({ title: `transcripts/${name}.md`, body });
    }
    const outputText = mask(JSON.stringify(outputs, null, 2));
    await fs.writeFile(path.join(tmp, 'outputs.json'), outputText);
    if (omitted.length > 0) gaps.add('files_omitted');
    const manifest = {
      subject, kind: plan.kind, ranges: plan.ranges, ...(plan.repoAt ? { repoAt: plan.repoAt } : {}), gaps: [...gaps], ...(omitted.length > 0 ? { omitted } : {}),
    };
    await fs.writeFile(path.join(tmp, 'evidence.json'), JSON.stringify(manifest, null, 2));
    sections.unshift({ title: 'evidence.json', body: JSON.stringify(manifest) });
    sections.push({ title: 'outputs.json', body: outputText });
    await fs.writeFile(path.join(tmp, FENCED), fencedEvidence(sections, 'diff.patch, repo/, transcripts/, outputs.json and evidence.json'));
  });
  return content ? { ok: true } : { ok: false, code: 'evidence_empty' };
}

/** Writes prompt.md in `dir`, which collectEvidence filled: what `rubrics` ask, then the fenced evidence. */
async function assembleJudgePrompt(config: LocalConfig, dir: string, rubrics: Rubrics): Promise<void> {
  const mask = await secretMask(config);
  const fenced = await fs.readFile(path.join(dir, FENCED), 'utf8');
  await fs.writeFile(path.join(dir, 'prompt.md'), mask(rubricPrompt(rubrics)) + fenced);
}

/**
 * The evidence of `subject` in `dir`, and the prompt that judges it with `rubrics`. A benchmark trial's is the copy of
 * what was collected from its clone when its prompt was reported, and none was is `evidence_empty`: the run's checkout
 * never held its work.
 */
export async function buildEvidence(config: LocalConfig, run: RunState, subject: RunSubject, rubrics: Rubrics, dir: string): Promise<{ ok: true } | { ok: false; code: 'evidence_empty' }> {
  if (stepDefinitions(run)(subject.step)?.trial) {
    const collected = subjectEvidenceDirOf(scoresDir(config), subject);
    if (!await isEvidenceReady(collected)) return { ok: false, code: 'evidence_empty' };
    if (!await isEvidenceReady(dir)) await writeEvidence(dir, (tmp) => fs.cp(collected, tmp, { recursive: true }));
    await assembleJudgePrompt(config, dir, rubrics);
    return { ok: true };
  }
  const collected = await collectEvidence(config, run, subject, dir);
  await assembleJudgePrompt(config, dir, rubrics);
  return collected;
}
