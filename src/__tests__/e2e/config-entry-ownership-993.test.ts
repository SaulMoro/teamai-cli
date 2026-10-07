/**
 * E2E (#993 bug 12): ownership of entries teamai writes into shared config
 * files, MCP servers and team hook entries, when teamai has no record of them.
 *
 * An unrecorded entry that equals teamai's render of a team server or hook, at
 * the team repo's current revision or an earlier one, is teamai's: it is
 * adopted and updated. Any other unrecorded entry in teamai's way is the
 * member's: kept, named by pull, and listed by doctor.
 *
 * Each case gets its own team remote: a local bare repo reached through a
 * synthetic HTTPS URL (`url.<path>.insteadOf` in the sandbox HOME), so cases
 * can publish team changes without affecting each other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex } from '../helpers/fake-codex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
let home: string;
let fakeCodexDir: string;

function env(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    CODEX_HOME: path.join(home, '.codex'),
    PATH: `${fakeCodexDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
  };
  delete base.CLAUDE_CONFIG_DIR;
  return base;
}

function run(command: string, args: string[], cwd: string): Run {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function gitOk(args: string[], cwd: string): string {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  return r.output.trim();
}

const teamai = (args: string[], cwd: string): Run => run(process.execPath, [CLI, ...args], cwd);

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A team: a seed checkout and the bare remote its synthetic URL reaches. */
interface Team { url: string; seed: string; publish(files: Record<string, string>, message: string): void }

function team(name: string, files: Record<string, string>, sharing: string[] = []): Team {
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []',
    'sharing:', '  mcp:', '    autoApply: true', '  hooks:', '    autoApply: true', '    requireTeamScripts: false', ...sharing, '',
  ].join('\n'));
  gitOk(['init', '-q', '-b', 'main'], seed);
  const publish = (next: Record<string, string>, message: string): void => {
    for (const [rel, content] of Object.entries(next)) writeFile(path.join(seed, rel), content);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', message], seed);
    if (fs.existsSync(remote)) gitOk(['push', '-q', remote, 'main'], seed);
  };
  publish(files, 'seed');
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  return { url, seed, publish };
}

/** A git business repo holding `files` before teamai is set up in it. */
function business(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(sandbox, name);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  return fs.realpathSync.native(dir);
}

function init(t: Team, dir: string, agents: string): Run {
  const r = teamai(['init', t.url, '--provider', 'git', '--agent', agents, '--scope', 'project', '--force'], dir);
  if (r.code !== 0) throw new Error(`teamai init failed: ${r.output}`);
  return r;
}

function pull(dir: string, ...args: string[]): Run {
  const r = teamai(['pull', ...args], dir);
  if (r.code !== 0) throw new Error(`teamai pull failed: ${r.output}`);
  return r;
}

const mcpYaml = (url: string): string => `servers:\n  - name: plain-api\n    transport: http\n    url: ${url}\n`;
const hooksYaml = (command: string): string =>
  `hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: ${command}\n`;

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const mcpServer = (dir: string, name: string): unknown => readJson(path.join(dir, '.mcp.json')).mcpServers?.[name];

/** The Claude Stop entries that carry teamai's marker for `team-stop`. */
const claudeTeamStops = (dir: string): Array<{ hooks: Array<{ command: string }> }> =>
  (readJson(path.join(dir, '.claude', 'settings.local.json')).hooks?.Stop ?? [])
    .filter((e: { description?: string }) => e.description?.startsWith('[teamai:hook:team-stop]'));
/** The commands of the Codex Stop entries. */
const codexStops = (dir: string): string[] =>
  (readJson(path.join(dir, '.codex', 'hooks.json')).hooks?.Stop ?? []).map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command);

/** Every main-checkout hook manifest under the sandbox HOME's data home. */
function removeHookManifests(): void {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'managed-main-checkout-hooks.json' ? [path.join(dir, e.name)] : []);
  const found = walk(path.join(home, '.teamai'));
  expect(found.length).toBeGreaterThan(0);
  for (const file of found) fs.rmSync(file);
}

describe('ownership of unrecorded MCP servers and hook entries (#993 bug 12)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-entry-ownership-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fakeCodexDir = installFakeCodex();
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    if (fakeCodexDir) fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  });

  it('keeps the member\'s same-name MCP server through init and pull --force, names it, and doctor lists it', () => {
    const t = team('own-server', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    t.publish({ 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v2') }, 'v2');
    const mine = { type: 'http', url: 'https://mine.example.com/mcp' };
    const dir = business('own-server-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': mine } }) });

    init(t, dir, 'claude');
    expect(mcpServer(dir, 'plain-api')).toEqual(mine);

    const pulled = pull(dir, '--force');
    expect(mcpServer(dir, 'plain-api')).toEqual(mine);
    expect(pulled.output).toContain(`Kept MCP server plain-api in ${path.join(dir, '.mcp.json')}: it is not teamai's`);
    expect(pulled.output).toContain('Rename or delete it, then run teamai pull, to receive the team version.');

    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toMatch(/not teamai's[^\n]*plain-api|plain-api[^\n]*not teamai's/);
  });

  it('adopts an unrecorded MCP server equal to an older team render, and updates it', () => {
    const t = team('older-server', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    t.publish({ 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v2') }, 'v2');
    const v1 = { type: 'http', url: 'https://team.example.com/v1' };
    const dir = business('older-server-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': v1 } }) });

    const initRun = init(t, dir, 'claude');
    expect(mcpServer(dir, 'plain-api')).toEqual({ type: 'http', url: 'https://team.example.com/v2' });
    expect(initRun.output).not.toContain('Kept MCP server');
  });

  it('adopts an unrecorded MCP server equal to the current team render, so later team changes reach it', () => {
    const t = team('current-server', { 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v1') });
    const v1 = { type: 'http', url: 'https://team.example.com/v1' };
    const dir = business('current-server-biz', { '.mcp.json': JSON.stringify({ mcpServers: { 'plain-api': v1 } }) });

    init(t, dir, 'claude');
    expect(mcpServer(dir, 'plain-api')).toEqual(v1);

    t.publish({ 'mcp/mcp.yaml': mcpYaml('https://team.example.com/v3') }, 'v3');
    const pulled = pull(dir);
    expect(mcpServer(dir, 'plain-api')).toEqual({ type: 'http', url: 'https://team.example.com/v3' });
    expect(pulled.output).not.toContain('Kept MCP server');
  });

  it('leaves one entry per team hook in Claude and Codex files, with and without the hook manifest', () => {
    // The co-author setting shares settings.local.json with the team hooks (#993 bug 7).
    const t = team('hook-manifest', { 'hooks/hooks.yaml': hooksYaml('echo team-stop-v1') }, ['  coAuthor:', '    enabled: false']);
    const dir = business('hook-manifest-biz', { '.claude/.keep': '' });
    init(t, dir, 'claude,codex');
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(codexStops(dir)).toEqual(['echo team-stop-v1']);
    const settings = path.join(dir, '.claude', 'settings.local.json');
    const attribution = { commit: '', pr: '' };
    expect(readJson(settings).attribution).toEqual(attribution);

    // Recorded entries are updated as before.
    t.publish({ 'hooks/hooks.yaml': hooksYaml('echo team-stop-v2') }, 'v2');
    pull(dir);
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(claudeTeamStops(dir)[0].hooks[0].command).toMatch(/echo team-stop-v2$/);
    expect(codexStops(dir)).toEqual(['echo team-stop-v2']);

    // The record is lost, and the file rewritten in another layout with another key first: the
    // entries equal today's render and are recognized; the key teamai's hooks do not own stays.
    removeHookManifests();
    const { hooks, ...rest } = readJson(settings);
    fs.writeFileSync(settings, JSON.stringify({ ...rest, hooks }));
    pull(dir, '--force');
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(codexStops(dir)).toEqual(['echo team-stop-v2']);
    expect(readJson(settings).attribution).toEqual(attribution);

    // Lost again, and the team changed the hook: the entries equal an older render.
    removeHookManifests();
    t.publish({ 'hooks/hooks.yaml': hooksYaml('echo team-stop-v3') }, 'v3');
    const pulled = pull(dir, '--force');
    expect(claudeTeamStops(dir)).toHaveLength(1);
    expect(claudeTeamStops(dir)[0].hooks[0].command).toMatch(/echo team-stop-v3$/);
    expect(codexStops(dir)).toEqual(['echo team-stop-v3']);
    expect(pulled.output).not.toContain('Kept the');
    expect(readJson(settings).attribution).toEqual(attribution);
  });

  it('keeps and names an unrecorded hook entry that matches no team render, or more than one, and doctor lists it', () => {
    const t = team('hook-foreign', {
      'hooks/hooks.yaml': [
        'hooks:',
        '  - id: team-stop',
        '    description: Team stop',
        '    event: Stop',
        '    command: echo team-stop',
        '  - id: twin-a',
        '    description: Twin A',
        '    event: SessionStart',
        '    command: echo twin',
        '    tools: [codex]',
        '  - id: twin-b',
        '    description: Twin B',
        '    event: SessionStart',
        '    command: echo twin',
        '    tools: [codex]',
        '',
      ].join('\n'),
    });
    const memberStop = { matcher: '*', hooks: [{ type: 'command', command: 'echo my-own-stop' }], description: '[teamai:hook:team-stop] Team stop' };
    const memberTwin = { hooks: [{ type: 'command', command: 'echo twin' }] };
    const dir = business('hook-foreign-biz', {
      '.claude/settings.local.json': JSON.stringify({ hooks: { Stop: [memberStop] } }),
      '.codex/hooks.json': JSON.stringify({ hooks: { SessionStart: [memberTwin] } }),
    });

    const initRun = init(t, dir, 'claude,codex');
    const settings = path.join(dir, '.claude', 'settings.local.json');
    const codexFile = path.join(dir, '.codex', 'hooks.json');
    // The member's entries stay, and the team's are written beside them.
    expect(readJson(settings).hooks.Stop[0]).toEqual(memberStop);
    expect(claudeTeamStops(dir)).toHaveLength(2);
    expect(readJson(codexFile).hooks.SessionStart[0]).toEqual(memberTwin);
    expect(readJson(codexFile).hooks.SessionStart).toHaveLength(3);
    expect(initRun.output).toContain(`Kept the Stop hook entry team-stop in ${settings}: it is not teamai's`);
    expect(initRun.output).toContain(`Kept the SessionStart hook entry in ${codexFile}: it matches more than one team hook (twin-a, twin-b)`);

    const pulled = pull(dir, '--force');
    expect(readJson(settings).hooks.Stop[0]).toEqual(memberStop);
    expect(claudeTeamStops(dir)).toHaveLength(2);
    expect(readJson(codexFile).hooks.SessionStart).toHaveLength(3);
    expect(pulled.output).toContain(`Kept the Stop hook entry team-stop in ${settings}`);

    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toContain(`Kept the Stop hook entry team-stop in ${settings}`);
    expect(doctor.output).toContain(`Kept the SessionStart hook entry in ${codexFile}`);
  });
});
