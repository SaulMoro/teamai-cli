import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyInstructionPlan,
  planInstructionFiles,
  type InstructionTarget,
} from '../instruction-targets.js';
import {
  TEAMAI_CLAUDEMD_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CULTURE_START,
} from '../types.js';

const culture = (text: string) => `${TEAMAI_CULTURE_START}\n${text}\n${TEAMAI_CULTURE_END}`;
const claudemd = (text: string) => `${TEAMAI_CLAUDEMD_START}\n${text}\n${TEAMAI_CLAUDEMD_END}`;

describe('instruction file planning (#945)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-plan-')));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const target = (file: string, extra: Partial<InstructionTarget> = {}): InstructionTarget => ({
    path: path.join(dir, file),
    tools: ['claude'],
    recall: false,
    ...extra,
  });

  it('creates a missing target with the blocks only', async () => {
    const plan = await planInstructionFiles([target('CLAUDE.local.md')], { culture: culture('c'), claudemd: claudemd('s') });
    await applyInstructionPlan(plan, { dryRun: false });

    expect(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf8')).toBe(`${culture('c')}\n\n${claudemd('s')}\n`);
  });

  it('plans no change when the blocks are already current', async () => {
    const file = path.join(dir, 'CLAUDE.local.md');
    fs.writeFileSync(file, `# Mine\n\n${culture('c')}\n`);

    const plan = await planInstructionFiles([target('CLAUDE.local.md')], { culture: culture('c') });

    expect(plan.changes).toEqual([]);
  });

  it('leaves a block with a missing end marker intact and warns', async () => {
    const file = path.join(dir, 'AGENTS.md');
    const original = `# Project\n\n${TEAMAI_CLAUDEMD_START}\nold selection\n`;
    fs.writeFileSync(file, original);

    const plan = await planInstructionFiles([], {}, [target('AGENTS.md', { tools: [] })]);
    await applyInstructionPlan(plan, { dryRun: false });

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(plan.warnings.join('\n')).toMatch(/AGENTS\.md.*incomplete teamai claudemd block.*by hand/);
  });

  it('removes stale blocks and keeps the authored text', async () => {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, `# Project\n\nAuthored.\n\n${culture('c')}\n\n${claudemd('dev')}\n`);

    const plan = await planInstructionFiles([], {}, [target('AGENTS.md', { tools: [] })]);
    await applyInstructionPlan(plan, { dryRun: false });

    expect(fs.readFileSync(file, 'utf8')).toBe('# Project\n\nAuthored.\n');
  });

  it('deletes a stale file that held only teamai blocks and is not tracked by git', async () => {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, `\n\n${culture('c')}\n`);

    const plan = await planInstructionFiles([], {}, [target('AGENTS.md', { tools: [] })]);
    await applyInstructionPlan(plan, { dryRun: false });

    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a tracked stale file that held only teamai blocks, emptied', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, `${culture('c')}\n`);
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: dir });

    const plan = await planInstructionFiles([], {}, [target('AGENTS.md', { tools: [] })]);
    await applyInstructionPlan(plan, { dryRun: false });

    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('writes nothing in a dry run and reports each file', async () => {
    const file = path.join(dir, 'AGENTS.md');
    const original = `# Project\n\n${culture('c')}\n`;
    fs.writeFileSync(file, original);

    const plan = await planInstructionFiles([target('CLAUDE.local.md')], { culture: culture('c') }, [target('AGENTS.md', { tools: [] })]);
    const { report } = await applyInstructionPlan(plan, { dryRun: true });

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(dir, 'CLAUDE.local.md'))).toBe(false);
    expect(report).toEqual([
      `Would write teamai instruction blocks to ${path.join(dir, 'CLAUDE.local.md')}`,
      `Would remove teamai instruction blocks from ${file}`,
    ]);
  });

  it('keeps a same-named file teamai does not own and reports it', async () => {
    const file = path.join(dir, 'teamai-context.mdc');
    fs.writeFileSync(file, 'my own rule\n');

    const plan = await planInstructionFiles([target('teamai-context.mdc', { header: '---\nalwaysApply: true\n---\n', owned: true })], { culture: culture('c') });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings.join('\n')).toMatch(/teamai-context\.mdc.*not written by teamai.*left it unchanged/);
  });

  it('writes the header above the blocks and deletes the owned file once its blocks are gone', async () => {
    const file = path.join(dir, 'teamai-context.mdc');
    const header = '---\nalwaysApply: true\n---\n';
    const owned = target('teamai-context.mdc', { header, owned: true });

    await applyInstructionPlan(await planInstructionFiles([owned], { culture: culture('c') }), { dryRun: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(`${header}\n${culture('c')}\n`);

    await applyInstructionPlan(await planInstructionFiles([owned], { culture: null, claudemd: null }), { dryRun: false });
    expect(fs.existsSync(file)).toBe(false);
  });
});
