import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { environmentNotes, isToolOwnState, ownStateOf } from './ledger.js';

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
    expect(isToolOwnState(entry, text)).toBe(own);
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
    // What teamai's probe of OpenCode leaves (`opencode --version`) stays teamai's until teamai stops leaving it.
    ['home/.cache/opencode/version', sha, undefined],
    ['home/.local/share/opencode/log/x.log', sha, undefined],
    ['home/.local/state/opencode', 'dir', undefined],
  ])('judges %s holding %s as the state of %o', (entry, value, own) => {
    expect(ownStateOf(entry, value)).toEqual(own);
  });
});
