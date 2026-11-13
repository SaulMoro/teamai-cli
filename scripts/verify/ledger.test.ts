import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { environmentNotes, ledgerRules, toolInstancesIn } from './ledger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("a ledger's section (d)", () => {
  it("names the variables the world's commands got and those of each member's, never a value", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-env-'));
    roots.push(bin);
    fs.writeFileSync(path.join(bin, 'run'), "#!/bin/sh\nexec env -i HOME='/w/home' PATH='/w/bin' \"$@\"\n");
    const place = { home: '/w/m/carol/home', project: '/w/m/carol/project', tmp: '/tmp/carol', writers: '/w/m/carol/writers.json', baseline: { files: {} } };

    const notes = environmentNotes({ bin, members: [{ machine: 'container', container: 'teamai-verify-x-carol', name: 'carol', env: { HOME: '/w/m/carol/home', PATH: '/usr/bin', SECRET_VALUE_NAME: 'v4lue-not-shown' }, ...place }] });

    expect(notes).toEqual(['commands got only: HOME, PATH', "@carol's commands got only: HOME, PATH, SECRET_VALUE_NAME"]);
    expect(notes.join('\n')).not.toContain('v4lue');
  });
});

describe("a tool's own state file in a ledger's section (e)", () => {
  it.each([
    ['home/.claude.json', '{"numStartups":1,"projects":{"/w/project":{"allowedTools":[]}}}', true],
    ['home/.claude.json', '{"mcpServers":{}}', true],
    ['home/.claude.json', '{"projects":{"/private/var/folders/x/T/teamai-verify/20261112T120000-aaaaaa/project":{"allowedTools":[]}}}', true],
    ['home/.claude.json', '{"mcpServers":{"docs":{"command":"node"}}}', false],
    ['home/.claude.json', '{"projects":{"/w/project":{"mcpServers":{"docs":{"command":"node"}}}}}', false],
    ['home/.claude.json', '{"hooks":"teamai hook"}', false],
    ['home/.claude.json', 'not json', false],
    ['home/.codebuddy.json', '{"numStartups":1}', true],
    ['home/.codebuddy.json', '{"projects":{"/w/project":{"mcpServers":{"docs":{"command":"node"}}}}}', false],
    ['home/.other.json', '{}', false],
  ])('judges %s holding %s as the tool\'s own: %s', (entry, text, own) => {
    expect(ledgerRules([]).isToolOwnState(entry, text)).toBe(own);
  });
});

describe("another program's own state in a ledger's section (e)", () => {
  const SBX = 'home/Library/Application Support/com.docker.sandboxes';
  const SBX_CACHE = 'home/Library/Caches/com.docker.sandboxes';
  const sha = 'f'.repeat(64);

  it.each([
    ['home/.claude/projects/-w-project/s.jsonl', sha, { kind: 'state', owner: 'the tool', dir: 'home/.claude' }],
    ['home/.claude', 'dir', undefined],
    ['home/.claude/skills/teamai-share/SKILL.md', sha, undefined],
    ['project/.git/refs/heads/main', 'f'.repeat(40), undefined],
    // T3 Code checkpoints a thread's project under refs/t3 (its CheckpointService and git driver).
    ['project/.git/refs/t3/checkpoints/turns/1', sha, { kind: 'state', owner: 'T3 Code', dir: 'project/.git/refs/t3' }],
    ['project/.git/refs/t3/orchestration-v2/checkpoints/x', sha, { kind: 'state', owner: 'T3 Code', dir: 'project/.git/refs/t3' }],
    ['project/.git/refs/t3', 'dir', { kind: 'state', owner: 'T3 Code', dir: 'project/.git/refs/t3' }],
    ['project/.git/refs/t3x', 'dir', undefined],
    ['project/.git/refs/t3/teamai/r1', sha, undefined],
    // What sbx v0.51.0 and v0.53.0 write on macOS in the HOME an `sbx ls` or `sbx template ls` is asked from while it is
    // not signed in there.
    [`${SBX}/sandboxes/analyticskit/events/default/anonymous/sandboxes~1~0.marlin.v1.proto`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/locks/dockerhub-refresh-77792493ac080e9d.lock`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/auth-cooldown`, 'dir', { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/settings.json.lock`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/sandboxd/client.log`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX_CACHE}/sandboxes/policykit/governor.db`, sha, { kind: 'state', owner: 'sbx', dir: SBX_CACHE }],
    // What sbx v0.53.0 adds there for `sbx secret ls`, which teamai asks once `sbx ls` answers: its update check and its
    // feature toggles.
    [`${SBX}/sandboxes/sandboxd/update-state.json`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX_CACHE}/sandboxes/unleash-toggles-production.json`, sha, { kind: 'state', owner: 'sbx', dir: SBX_CACHE }],
    // A folder that holds them is judged by what it holds.
    [`${SBX}/sandboxes/sandboxd`, 'dir', { kind: 'folder', owner: 'sbx' }],
    ['home/Library', 'dir', { kind: 'folder', owner: 'sbx' }],
    // Its image store holds the templates teamai saves (teamai-warm:<key>) and the disks of the sandboxes it makes.
    [`${SBX}/sandboxes/sandboxd/containerd`, 'dir', undefined],
    [`${SBX}/sandboxes/sandboxd/containerd/root/io.containerd.content.v1.content/blobs/sha256/${'a'.repeat(64)}`, sha, undefined],
    [`${SBX}/sandboxes/settings.json`, sha, undefined],
    ['home/Library/Preferences', 'dir', undefined],
    ['home/Library/Preferences/com.example.plist', sha, undefined],
    // OpenCode's own folders under the XDG folders of a HOME that sets none, as v2.3.0 fills them: on any start,
    // `opencode --version` included, and in a session a step opens (its database, shell and snapshot folders).
    ['home/.cache/opencode/bin', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.cache/opencode' }],
    ['home/.local/share/opencode/log/opencode.log', sha, { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/share/opencode/repos', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/share/opencode/opencode.db', sha, { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/share/opencode/snapshot/cb253d22366577419c7461916f9a348b44041300', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/state/opencode', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.local/state/opencode' }],
    ['home/.local/state/opencode/prompt-history.jsonl', sha, { kind: 'state', owner: 'OpenCode', dir: 'home/.local/state/opencode' }],
    // The folders that hold them are judged by what they hold.
    ['home/.cache', 'dir', { kind: 'folder', owner: 'OpenCode' }],
    ['home/.local/share', 'dir', { kind: 'folder', owner: 'OpenCode' }],
    ['home/.local', 'dir', { kind: 'folder', owner: 'OpenCode' }],
    // Nothing beyond OpenCode's own folders: not what its TUI keeps elsewhere, nor another program's beside them.
    ['home/.local/share/opentui/tree-sitter', 'dir', undefined],
    ['home/Library/Caches/bun', 'dir', undefined],
    ['home/.local/share/opencode-other/x.log', sha, undefined],
    ['home/.local/bin', 'dir', undefined],
    ['home/.cache/teamai/opencode/log/x.log', sha, undefined],
    ['home/.local/share/opencode/teamai-hooks.ts', sha, undefined],
  ])('judges %s holding %s as the state of %o', (entry, value, own) => {
    expect(ledgerRules([]).ownStateOf(entry, value)).toEqual(own);
  });
});

describe("a tool instance's home in a ledger's section (e)", () => {
  /** A HOME whose workspace install's team repo declares acme-claude, and whose member declares their own nested one. */
  function homeWithInstances(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-inst-'));
    roots.push(home);
    const dataHome = path.join(home, '.teamai', 'projects', 'w-project-0123456789abcdef');
    const team = path.join(dataHome, 'team-repo');
    fs.mkdirSync(path.join(team, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(team, 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\nhome: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }\n');
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), `repo:\n  localPath: ${team}\n  remote: https://teamai.test/team/repo.git\nscope: workspace\nenabledAgents:\n  - claude\n  - acme-claude\n`);
    // A home written with a leading ./ and a trailing / is the same folder.
    fs.writeFileSync(path.join(team, 'tools', 'beta-claude.yaml'), 'schemaVersion: v1alpha1\nname: beta-claude\nextends: claude\nhome: { dir: ./.beta/ }\n');
    fs.mkdirSync(path.join(home, '.teamai', 'tools', 'own-codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'tools', 'own-codex', 'TOOL.yaml'), 'schemaVersion: v1alpha1\nname: own-codex\nextends: codex\nhome: { dir: .own/codex }\n');

    return home;
  }

  it('reads every instance the install declares, with its home as teamai joins it to HOME', async () => {
    const instances = await toolInstancesIn(homeWithInstances());

    expect(instances.map((instance) => [instance.name, instance.home?.dir]).sort()).toEqual([['acme-claude', '.acme-claude'], ['beta-claude', '.beta'], ['own-codex', '.own/codex']]);
  });

  const sha = 'f'.repeat(64);

  // What a step run as acme-claude leaves in its home after uninstall, judged as Claude's own home is.
  it.each([
    ['home/.acme-claude/projects/-w-project/s.jsonl', sha, { kind: 'state', owner: 'the tool', dir: 'home/.acme-claude' }],
    ['home/.acme-claude/projects', 'dir', { kind: 'state', owner: 'the tool', dir: 'home/.acme-claude' }],
    ['home/.own/codex/sessions/2026/11/13/rollout.jsonl', sha, { kind: 'state', owner: 'the tool', dir: 'home/.own/codex' }],
    // What teamai writes there, where Claude reads it in its own home: never the tool's.
    ['home/.acme-claude/settings.json', sha, undefined],
    ['home/.acme-claude/skills/hello-world/SKILL.md', sha, undefined],
    ['home/.acme-claude/.claude.json', sha, undefined],
    ['home/.acme-claude/teamai-hooks.json', sha, undefined],
  ])('judges %s holding %s in an instance home as the state of %o', async (entry, value, own) => {
    const rules = ledgerRules(await toolInstancesIn(homeWithInstances()));

    expect(rules.ownStateOf(entry, value)).toEqual(own);
  });

  it("keeps an instance's home and its project folder as it keeps its tool's, and its state file as the tool's own while it holds no server", async () => {
    const rules = ledgerRules(await toolInstancesIn(homeWithInstances()));

    expect(['home/.acme-claude', 'home/.own', 'home/.own/codex', 'project/.acme-claude', 'home/.claude'].map((entry) => rules.knownLeftover(entry))).toEqual(['dir', 'dir', 'dir', 'dir', 'dir']);
    expect(rules.isToolOwnState('home/.acme-claude/.claude.json', '{"numStartups":1}')).toBe(true);
    expect(rules.isToolOwnState('home/.acme-claude/.claude.json', '{"mcpServers":{"docs":{"command":"node"}}}')).toBe(false);
  });

  it('keeps what teamai delivers to the paths an instance sets for itself a LEAK, as its tool\'s', async () => {
    const home = homeWithInstances();
    const team = path.join(home, '.teamai', 'projects', 'w-project-0123456789abcdef', 'team-repo');
    fs.writeFileSync(path.join(team, 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\nhome: { dir: .acme-claude }\npaths: { skills: .acme-claude/skills, settings: .acme-claude/settings.json, mcp: .acme-claude/.claude.json, userScope: { rules: .acme-claude/team-rules } }\n');
    const rules = ledgerRules(await toolInstancesIn(home));

    expect(['home/.acme-claude/skills/hello-world/SKILL.md', 'home/.acme-claude/settings.json', 'home/.acme-claude/.claude.json', 'home/.acme-claude/team-rules/style.md'].map((entry) => rules.ownStateOf(entry, sha))).toEqual([undefined, undefined, undefined, undefined]);
    expect(rules.ownStateOf('home/.acme-claude/projects/-w-project/s.jsonl', sha)).toEqual({ kind: 'state', owner: 'the tool', dir: 'home/.acme-claude' });
  });

  it('excuses nothing in the home of an instance it could not read', () => {
    const rules = ledgerRules([]);

    expect(rules.knownLeftover('home/.acme-claude')).toBeUndefined();
    expect(rules.ownStateOf('home/.acme-claude/projects/-w-project/s.jsonl', sha)).toBeUndefined();
    expect(rules.isToolOwnState('home/.acme-claude/.claude.json', '{"numStartups":1}')).toBe(false);
  });
});
