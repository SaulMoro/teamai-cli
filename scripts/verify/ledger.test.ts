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
  it.each([
    ['home/.claude/projects/-w-project/s.jsonl', 'f'.repeat(64), { owner: 'the tool', dir: 'home/.claude' }],
    ['home/.claude', 'dir', undefined],
    ['home/.claude/skills/teamai-share/SKILL.md', 'f'.repeat(64), undefined],
    ['project/.git/refs/heads/main', 'f'.repeat(40), undefined],
  ])('judges %s holding %s as the state of %o', (entry, value, own) => {
    expect(ownStateOf(entry, value)).toEqual(own);
  });
});
