import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { parse as parseToml } from 'smol-toml';
import { expect, it } from 'vitest';
import YAML from 'yaml';

const cli = path.resolve('dist/index.js');

/**
 * Model aliases (#830) through the built CLI, as one member's sequence on an
 * unchanged team revision: a local override, push, switching tools to a
 * model profile and back, each taking effect on an ordinary pull; then a
 * teammate's alias change the member pushes over before pulling, and the
 * doctor view. One `it`, because each step starts from the state the last
 * one left, and a retried step would not.
 */
it('keeps model aliases right across overrides, pushes, switches and a teammate change', () => {
  if (!fs.existsSync(cli)) throw new Error('Run npm run build before the E2E test.');
  // realpath: on macOS the tmpdir is a symlink, and toolRoots must sit under HOME.
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-model-aliases-')));
  try {
    const home = path.join(sandbox, 'home');
    const teamHome = path.join(home, '.teamai');
    const repo = path.join(teamHome, 'team-repo');
    const remote = path.join(sandbox, 'remote.git');
    const teammate = path.join(sandbox, 'teammate');
    const claudeDir = path.join(home, 'custom-claude');
    const codexDir = path.join(home, 'custom-codex');
    const write = (file: string, content: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };

    write(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'Alias test', repo: 'https://example.invalid/team.git', provider: 'git' }));
    const teamAliases = (claudeEffort: string, codexModel: string): string => YAML.stringify({
      aliases: { strong: { claude: { model: 'opus', effort: claudeEffort }, codex: { model: codexModel, effort: 'high' } } },
    });
    write(path.join(repo, 'models', 'aliases.yaml'), teamAliases('high', 'gpt-6-sol'));
    write(path.join(repo, 'models', 'models.yaml'), YAML.stringify({ profiles: [{
      id: 'tokenhub', name: 'TokenHub', base_url: 'https://gateway.example.test', api_key: '${API_KEY}',
      model_groups: [
        { protocols: ['anthropic'], models: ['claude-opus-4-8', 'claude-sonnet-4-6'] },
        { protocols: ['anthropic', 'openai-responses'], models: ['deepseek-v4-flash'] },
      ],
    }] }));
    const canonical = { name: 'implementer', description: 'Implements a change', instructions: 'Make the change.', model: 'strong' };
    write(path.join(repo, 'agents', 'implementer.yaml'), YAML.stringify(canonical));
    write(path.join(teamHome, 'models', 'models.yaml'), 'profiles: []\n');
    write(path.join(teamHome, 'config.yaml'), YAML.stringify({
      repo: { kind: 'git', localPath: repo, remote },
      username: 'tester',
      scope: 'user',
      enabledAgents: ['claude', 'codex'],
      toolRoots: { claude: 'custom-claude' },
    }));
    write(path.join(claudeDir, 'settings.json'), '{}');
    write(path.join(codexDir, 'config.toml'), 'model = "personal"\n');
    // Codex agents land in ~/.codex/agents whatever CODEX_HOME says.
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
      FIXTURE_MODEL_KEY: 'fixture-key',
      NO_COLOR: '1',
    };
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(key) || key === 'OPENCODE_CONFIG' || key === 'XDG_CONFIG_HOME') delete env[key];
    }
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
    const teamai = (...args: string[]): { status: number | null; stdout: string; output: string } => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: home, env, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
    };
    const ok = (...args: string[]): string => {
      const { status, output } = teamai(...args);
      expect(status, `teamai ${args.join(' ')}\n${output}`).toBe(0);
      return output;
    };
    const ordinaryPull = (): string => {
      const output = ok('pull');
      expect(output).toMatch(/Already synced at \w+, skipping/);
      return output;
    };

    git(sandbox, 'init', '-q', '--bare', '--initial-branch=main', remote);
    git(repo, 'init', '-q', '--initial-branch=main');
    git(repo, 'config', 'user.name', 'TeamAI Test');
    git(repo, 'config', 'user.email', 'teamai@example.test');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'team aliases and profile');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const head = git(repo, 'rev-parse', 'HEAD');

    const codexFile = path.join(home, '.codex', 'agents', 'implementer.toml');
    const claudeFile = path.join(claudeDir, 'agents', 'implementer.md');
    const codex = (): Record<string, unknown> => parseToml(fs.readFileSync(codexFile, 'utf8'));
    const claude = (): Record<string, unknown> => matter(fs.readFileSync(claudeFile, 'utf8')).data;
    const noEdit = (output: string): void => {
      expect(output).toContain('No new or modified resources to push');
      expect(output).not.toContain('Push never writes a concrete model');
    };

    // Team strong = A/high.
    ok('pull');
    expect(codex()).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    expect(claude()).toMatchObject({ model: 'opus', effort: 'high' });

    // Local override B/low reaches Codex on an ordinary pull, and is no edit to push.
    write(path.join(teamHome, 'models', 'aliases.yaml'), 'aliases:\n  strong:\n    codex: { model: gpt-6-astra, effort: low }\n');
    expect(ordinaryPull()).toContain('Updated the model of 1 agent(s): implementer');
    expect(codex()).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'low' });
    noEdit(ok('push', '--dry-run'));

    // An unrelated Codex field is the only edit push proposes: model stays strong.
    const pulledCodex = fs.readFileSync(codexFile, 'utf8');
    fs.appendFileSync(codexFile, 'sandbox_mode = "read-only"\n');
    const dryRun = ok('push', '--dry-run');
    expect(dryRun).toContain('[agents] implementer (modified)');
    expect(dryRun).not.toContain('Push never writes a concrete model');
    // provider git: the branch is pushed, the PR cannot be opened.
    expect(teamai('push', '--all').output).toMatch(/Pushed branch teamai\/push\//);
    const branch = git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push').trim();
    expect(YAML.parse(git(remote, 'show', `${branch}:agents/implementer.yaml`))).toEqual({
      ...canonical,
      tool_extras: { codex: { sandbox_mode: 'read-only' } },
    });
    fs.writeFileSync(codexFile, pulledCodex);

    // Codex switched to a team profile: no alias model, no effort.
    ok('models', 'configure', 'team:tokenhub', '--from-env', 'FIXTURE_MODEL_KEY');
    expect(ok('models', 'switch', 'tokenhub', '--agent', 'codex')).toContain('codex switched to team:tokenhub');
    ordinaryPull();
    expect(codex()).toMatchObject({ name: 'implementer' });
    expect(codex()).not.toHaveProperty('model');
    expect(codex()).not.toHaveProperty('model_reasoning_effort');

    // Claude switched too: the family alias stays for the switch to route, effort goes.
    expect(ok('models', 'switch', 'tokenhub', '--agent', 'claude')).toContain('claude switched to team:tokenhub');
    ordinaryPull();
    expect(claude()).toMatchObject({ model: 'opus' });
    expect(claude()).not.toHaveProperty('effort');

    // Restore: B/low and opus/high are back.
    ok('models', 'restore');
    ordinaryPull();
    expect(codex()).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'low' });
    expect(claude()).toMatchObject({ model: 'opus', effort: 'high' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);

    // A teammate changes strong (Codex to C, and Claude's effort, which this
    // member takes from the team); the member pushes before pulling.
    git(sandbox, 'clone', '-q', remote, teammate);
    git(teammate, 'config', 'user.name', 'Mate');
    git(teammate, 'config', 'user.email', 'mate@example.test');
    write(path.join(teammate, 'models', 'aliases.yaml'), teamAliases('max', 'gpt-6-nova'));
    git(teammate, 'commit', '-qam', 'strong: gpt-6-nova for codex, max for claude');
    git(teammate, 'push', '-q', 'origin', 'main');
    noEdit(ok('push', '--dry-run'));
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(claude()).toMatchObject({ model: 'opus', effort: 'high' });

    // Doctor: model, effort and step per tool, and what the last pull deployed.
    const report = JSON.parse(teamai('doctor', '--json').stdout) as { notes: string[] };
    const view = report.notes.find((note) => note.startsWith('models: how model: strong resolves for agent implementer:'));
    expect(view).toBeDefined();
    expect(view).toContain('claude: opus, effort max  [team: models/aliases.yaml]; the last pull deployed opus, effort high  [team: models/aliases.yaml]');
    expect(view).toContain(`codex: gpt-6-astra, effort low  [local: ${path.join(teamHome, 'models', 'aliases.yaml')}]`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
