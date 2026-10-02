import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  applyInstructionPlan,
  clearInstructionFile,
  instructionChannelProblems,
  planInstructionFiles,
  registerOpencodeContext,
  resolveInstructionTargets,
  type InstructionTarget,
} from '../instruction-targets.js';
import { injectPiHooks } from '../pi-hooks.js';
import {
  scopedToolPaths,
  toolInstallRoot,
  TeamaiConfigSchema,
  type LocalConfig,
  type TeamaiConfig,
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

  it('gives the recall block to a target whose tool has the subagent, and the direct variant otherwise', async () => {
    const recall = '<!-- [teamai:recall-rules:start] -->\nuse the subagent\n<!-- [teamai:recall-rules:end] -->';
    const direct = '<!-- [teamai:recall-rules:start] -->\nrun teamai recall\n<!-- [teamai:recall-rules:end] -->';
    const plan = await planInstructionFiles(
      [target('a.md', { recall: true }), target('b.md', { recall: false })],
      { recall, directRecall: direct },
    );

    expect(plan.changes.map((c) => c.content)).toEqual([`${recall}\n`, `${direct}\n`]);
  });

  it('restores the header of teamai\'s own rule file when it was lost or changed', async () => {
    const header = '---\nalwaysApply: true\n---\n';
    const own = target('teamai-context.mdc', { header, owned: true });
    const fresh = await planInstructionFiles([own], { culture: culture('c') });
    const expected = fresh.changes[0].content;
    for (const lost of [`${culture('c')}\n`, `---\nalwaysApply: false\n---\n\n${culture('c')}\n`]) {
      fs.writeFileSync(own.path, lost);
      const plan = await planInstructionFiles([own], { culture: culture('c') });
      expect(plan.changes.map((c) => c.content)).toEqual([expected]);
    }
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

  it('clears teamai\'s own teamai-context file whole, header included, on uninstall', async () => {
    const file = path.join(dir, 'teamai-context.mdc');
    fs.writeFileSync(file, `---\nalwaysApply: true\n---\n\n${culture('c')}\n`);

    expect((await clearInstructionFile(file)).changed).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps the member\'s text when uninstall clears another instruction file', async () => {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, `# Mine\n\n${claudemd('s')}\n`);

    await clearInstructionFile(file);

    expect(fs.readFileSync(file, 'utf8')).toBe('# Mine\n');
  });
});

describe('instruction channel problems (#945)', () => {
  it('names a missing Pi extension in a project, and nothing once it is installed', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-channel-')));
    const prevHome = process.env.HOME;
    process.env.HOME = path.join(root, 'home');
    try {
      const projectRoot = path.join(root, 'project');
      const repo = path.join(root, 'repo');
      // Pi is installed for the member (~/.pi); the project has no .pi/.
      fs.mkdirSync(path.join(root, 'home', '.pi'), { recursive: true });
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(path.join(repo, 'claudemd'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'claudemd', 'shared.md'), 'Shared.\n');
      const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' });
      const localConfig = {
        repo: { localPath: repo, remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot, enabledAgents: ['pi'],
      } as unknown as LocalConfig;

      expect((await instructionChannelProblems(teamConfig, localConfig)).join('\n')).toMatch(/teamai-hooks\.ts is missing or out of date, so pi sessions/);

      await injectPiHooks();
      expect(await instructionChannelProblems(teamConfig, localConfig)).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('instruction targets shared by several tools (#945)', () => {
  it('gives a shared file the subagent recall block only when every tool reading it has the subagent', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-shared-')));
    try {
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(path.join(projectRoot, '.codebuddy', 'skills'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.workbuddy', 'skills'), { recursive: true });
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot,
      } as unknown as LocalConfig;
      const resolve = async (workbuddyAgents: boolean) => (await resolveInstructionTargets(TeamaiConfigSchema.parse({
        team: 't',
        repo: 'https://example.invalid/t.git',
        toolPaths: {
          codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', agents: '.codebuddy/agents' },
          workbuddy: { skills: '.workbuddy/skills', rules: '.workbuddy/rules', ...(workbuddyAgents ? { agents: '.workbuddy/agents' } : {}) },
        },
      }), localConfig)).targets;

      const [mixed] = await resolve(false);
      expect(mixed).toMatchObject({ tools: ['codebuddy', 'workbuddy'], recall: false });
      const [both] = await resolve(true);
      expect(both).toMatchObject({ tools: ['codebuddy', 'workbuddy'], recall: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a tool configured without a rules directory (#945)', () => {
  it('keeps the configured claudemd as its target, as the member\'s own file, instead of retiring it', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-norules-')));
    try {
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot,
      } as unknown as LocalConfig;
      const teamConfig = TeamaiConfigSchema.parse({
        team: 't',
        repo: 'https://example.invalid/t.git',
        toolPaths: { claude: { settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md' } },
      });

      const { targets, stale } = await resolveInstructionTargets(teamConfig, localConfig);

      const file = path.join(projectRoot, '.claude', 'CLAUDE.md');
      expect(targets).toEqual([expect.objectContaining({ path: file, tools: ['claude'], header: undefined, owned: undefined })]);
      expect(stale.map((t) => t.path)).not.toContain(file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps WorkBuddy\'s configured project claudemd when its entry has no rules', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-wb-norules-')));
    try {
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(path.join(projectRoot, '.workbuddy'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.workbuddy', 'settings.json'), '{}\n');
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot,
      } as unknown as LocalConfig;
      const teamConfig = TeamaiConfigSchema.parse({
        team: 't',
        repo: 'https://example.invalid/t.git',
        toolPaths: { workbuddy: { settings: '.workbuddy/settings.json', claudemd: 'AGENTS.md' } },
      });

      const { targets, stale } = await resolveInstructionTargets(teamConfig, localConfig);

      const file = path.join(projectRoot, 'AGENTS.md');
      expect(targets).toEqual([expect.objectContaining({ path: file, tools: ['workbuddy'], header: undefined, owned: undefined })]);
      expect(stale.map((t) => t.path)).not.toContain(file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('probes a tool whose entry has only claudemd through that file\'s directory', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-onlymd-')));
    try {
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(projectRoot, { recursive: true });
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot,
      } as unknown as LocalConfig;
      const teamConfig = TeamaiConfigSchema.parse({
        team: 't', repo: 'https://example.invalid/t.git', toolPaths: { claude: { claudemd: '.claude/CLAUDE.md' } },
      });

      expect((await resolveInstructionTargets(teamConfig, localConfig)).targets).toEqual([]);
      fs.mkdirSync(path.join(projectRoot, '.claude'));
      expect((await resolveInstructionTargets(teamConfig, localConfig)).targets.map((t) => t.path))
        .toEqual([path.join(projectRoot, '.claude', 'CLAUDE.md')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('OpenCode\'s Claude fallback (#945)', () => {
  it('counts ~/.claude/CLAUDE.md as OpenCode\'s fallback while it holds blocks, even with Claude excluded', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-ocfallback-')));
    const prevHome = process.env.HOME;
    process.env.HOME = path.join(root, 'home');
    try {
      const home = process.env.HOME;
      fs.mkdirSync(path.join(home, '.config', 'opencode', 'skills'), { recursive: true });
      fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
      const claudeFile = path.join(home, '.claude', 'CLAUDE.md');
      fs.writeFileSync(claudeFile, `${claudemd('an earlier selection')}\n`);
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'user', enabledAgents: ['opencode'],
      } as unknown as LocalConfig;

      const resolved = await resolveInstructionTargets(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' }), localConfig);

      expect(resolved.opencodeFallback).toBe(claudeFile);
      expect(resolved.targets.map((t) => t.path)).not.toContain(path.join(home, '.config', 'opencode', 'teamai-context.md'));
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('OpenCode instructions registration (#945)', () => {
  it.each(['malformed', 'write failure', 'current', 'written'])('registers only delivered instructions when the target is %s', async (state) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-ocreg-')));
    try {
      const projectRoot = path.join(root, 'project');
      const file = path.join(projectRoot, '.opencode', 'teamai-context.md');
      fs.mkdirSync(path.join(projectRoot, '.opencode', 'skills'), { recursive: true });
      fs.writeFileSync(file, state === 'malformed' ? `${TEAMAI_CLAUDEMD_START}\nold selection\n` : `${claudemd(state === 'current' ? 'desired' : 'old selection')}\n`);
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot,
      } as unknown as LocalConfig;
      const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' });
      const resolved = await resolveInstructionTargets(teamConfig, localConfig);
      const plan = await planInstructionFiles(resolved.targets, { claudemd: claudemd('desired') });
      if (state === 'write failure') vi.spyOn(fse, 'writeFile').mockRejectedValueOnce(new Error('EACCES'));
      const { failures } = await applyInstructionPlan(plan, { dryRun: false });
      await registerOpencodeContext(teamConfig, localConfig, resolved, false, [], [...plan.warnings, ...failures]);

      const config = path.join(projectRoot, '.opencode', 'opencode.json');
      if (state === 'current' || state === 'written') {
        expect(JSON.parse(fs.readFileSync(config, 'utf8')).instructions).toEqual(['.opencode/teamai-context.md']);
        expect(fs.readFileSync(file, 'utf8')).toContain('desired');
      } else {
        expect(fs.existsSync(config)).toBe(false);
        expect(fs.readFileSync(file, 'utf8')).toContain('old selection');
      }
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the member\'s own listed teamai-context.md entry alone, in a dry run and a real pull', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-ocreg-')));
    try {
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(path.join(projectRoot, '.opencode', 'skills'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.opencode', 'teamai-context.md'), '# My own notes\n');
      const config = path.join(projectRoot, '.opencode', 'opencode.json');
      const listed = JSON.stringify({ instructions: ['.opencode/teamai-context.md'] });
      fs.writeFileSync(config, listed);
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot,
      } as unknown as LocalConfig;
      const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' });
      const resolved = await resolveInstructionTargets(teamConfig, localConfig);

      expect(await registerOpencodeContext(teamConfig, localConfig, resolved, true)).toBeNull();
      expect(await registerOpencodeContext(teamConfig, localConfig, resolved, false)).toBeNull();
      expect(fs.readFileSync(config, 'utf8')).toBe(listed);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Codex project instructions (#945)', () => {
  it('reaches a Codex the member relocated with toolRoots, with no project .codex/', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-codexroot-')));
    const prevHome = process.env.HOME;
    process.env.HOME = path.join(root, 'home');
    try {
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(path.join(root, 'home', '.codex-work', 'skills'), { recursive: true });
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot, toolRoots: { codex: '~/.codex-work' },
      } as unknown as LocalConfig;

      const resolved = await resolveInstructionTargets(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' }), localConfig);

      expect(resolved.hooks.map((hook) => hook.tool)).toContain('codex');
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a configured claudemd named like teamai\'s file (#945)', () => {
  it('is the member\'s file: an existing one gets the blocks beside its text', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-fallback-')));
    try {
      const projectRoot = path.join(root, 'project');
      const notes = path.join(projectRoot, '.claude', 'teamai-context.md');
      fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
      fs.writeFileSync(notes, '# My notes\n');
      const teamConfig = TeamaiConfigSchema.parse({
        team: 't', repo: 'https://example.invalid/t.git',
        toolPaths: { claude: { skills: '.claude/skills', claudemd: '.claude/teamai-context.md' } },
      });
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot, enabledAgents: ['claude'],
      } as unknown as LocalConfig;

      const { targets } = await resolveInstructionTargets(teamConfig, localConfig);
      const plan = await planInstructionFiles(targets.filter((t) => t.path === notes), { culture: culture('c') });

      expect(plan.warnings).toEqual([]);
      expect(plan.changes.map((c) => c.content)).toEqual([`# My notes\n\n${culture('c')}\n`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('OpenCode instructions ownership (#945)', () => {
  it('records the entry teamai adds, for uninstall, and forgets it once removed', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-ocown-')));
    const prevHome = process.env.HOME;
    process.env.HOME = path.join(root, 'home');
    try {
      const projectRoot = path.join(root, 'project');
      const context = path.join(projectRoot, '.opencode', 'teamai-context.md');
      fs.mkdirSync(path.join(projectRoot, '.opencode', 'skills'), { recursive: true });
      fs.writeFileSync(context, `${claudemd('team')}\n`);
      const config = path.join(projectRoot, '.opencode', 'opencode.json');
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope: 'project', projectRoot, dataHome: path.join(root, 'data'),
      } as unknown as LocalConfig;
      const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' });
      const { loadStateForScope } = await import('../config.js');

      await registerOpencodeContext(teamConfig, localConfig, await resolveInstructionTargets(teamConfig, localConfig), false);
      expect((await loadStateForScope(localConfig)).opencodeContextEntries).toEqual([{ config, entry: '.opencode/teamai-context.md' }]);

      fs.rmSync(context);
      const resolved = await resolveInstructionTargets(teamConfig, localConfig);
      await registerOpencodeContext(teamConfig, localConfig, { targets: [], stale: resolved.targets }, false);
      expect((await loadStateForScope(localConfig)).opencodeContextEntries).toEqual([]);

      // An entry the member listed, which teamai did not record, stays.
      fs.writeFileSync(config, JSON.stringify({ instructions: ['.opencode/teamai-context.md'] }));
      await registerOpencodeContext(teamConfig, localConfig, { targets: [], stale: resolved.targets }, false);
      expect(JSON.parse(fs.readFileSync(config, 'utf8')).instructions).toEqual(['.opencode/teamai-context.md']);
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('every tool and toolPaths shape keeps its instructions (#945)', () => {
  type Paths = TeamaiConfig['toolPaths'][string];
  const DEFAULTS = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' });
  const SHAPES: Record<string, (paths: Paths) => Paths> = {
    full: (paths) => paths,
    'without rules': ({ rules: _rules, ...rest }) => rest,
    'only claudemd': (paths) => (paths.claudemd === undefined ? {} : { claudemd: paths.claudemd }),
    'only settings': (paths) => (paths.settings === undefined ? {} : { settings: paths.settings }),
  };
  const cases = (['user', 'project'] as const).flatMap((scope) =>
    Object.keys(DEFAULTS.toolPaths).flatMap((tool) => Object.keys(SHAPES).map((shape) => [scope, tool, shape] as const)));

  it.each(cases)('%s scope, %s, %s: an installed tool with a claudemd still gets the blocks, and no target is retired', async (scope, tool, shape) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-shapes-')));
    const saved = { HOME: process.env.HOME, HERMES_HOME: process.env.HERMES_HOME, COPILOT_HOME: process.env.COPILOT_HOME };
    process.env.HOME = path.join(root, 'home');
    process.env.HERMES_HOME = path.join(root, 'hermes');
    process.env.COPILOT_HOME = path.join(root, 'copilot');
    try {
      const projectRoot = path.join(root, 'project');
      const localConfig = {
        repo: { localPath: path.join(root, 'repo'), remote: 'https://example.invalid/t.git' },
        username: 'u', additionalRoles: [], scope, ...(scope === 'project' ? { projectRoot } : {}),
      } as unknown as LocalConfig;
      const paths = SHAPES[shape](scopedToolPaths(DEFAULTS, localConfig)[tool]);
      const base = scope === 'project' ? projectRoot : process.env.HOME;
      for (const dir of [process.env.HERMES_HOME, process.env.COPILOT_HOME, path.join(process.env.HOME, '.omp')]) fs.mkdirSync(dir, { recursive: true });
      for (const value of Object.values(paths)) {
        if (typeof value === 'string') fs.mkdirSync(path.join(base, toolInstallRoot(value)), { recursive: true });
      }
      const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git', toolPaths: { [tool]: paths } });

      const { targets, hooks, stale } = await resolveInstructionTargets(teamConfig, localConfig);

      const targetPaths = new Set(targets.map((t) => t.path));
      expect(stale.filter((t) => targetPaths.has(t.path))).toEqual([]);
      if (paths.claudemd !== undefined) {
        expect([...targets.flatMap((t) => t.tools), ...hooks.map((h) => h.tool)]).toContain(tool);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
