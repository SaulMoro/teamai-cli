import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDriver } from '../workflow/runtimes/definitions.js';
import { openDriver } from '../workflow/runtimes/sources.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';

/**
 * A step runtime as a resource: `runtimes/<name>.yaml`, or a folder `runtimes/<name>/` with its `RUNTIME.yaml` and its
 * code, of the member, the team or teamai, found as `driver.runtimes[].use` names it.
 */

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const kind of ['drivers', 'runtimes', 'trust']) fs.rmSync(path.join(getTeamaiHomeDir(), kind), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A user-scope config whose team repo holds `files`, and a definition `acme` that uses runtime `use`. */
function teamWith(files: Record<string, string>, use = 'acme'): LocalConfig {
  const team = tempDir('teamai-runtime-resources-');
  const all = { 'drivers/acme.yaml': `schemaVersion: v1alpha1\nname: acme\nruntimes:\n  - use: ${use}\n`, ...files };
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(team, file)), { recursive: true });
    fs.writeFileSync(path.join(team, file), text, { mode: file.endsWith('/runtime') ? 0o755 : 0o644 });
  }
  return { repo: { localPath: team, remote: 'origin', kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [] };
}

/** A directory on PATH holding an executable named `name`. */
function onPath(name: string): string {
  const bin = tempDir('teamai-runtime-bin-');
  fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`);
  return path.join(bin, name);
}

/** Writes the member's own `files` under ~/.teamai/. */
function personal(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(getTeamaiHomeDir(), file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text, { mode: file.endsWith('/runtime') ? 0o755 : 0o644 });
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const open = (config: LocalConfig) => openDriver(config, 'acme', { personal: true, mode: 'unattended', canAsk: false, purpose: 'check', checkout: config.repo.localPath });

const COMMAND_RUNTIME = 'protocol: 1\nentry: { command: acme-runtime }\n';

describe('a team runtime file', () => {
  it('finds a team runtimes/acme.yaml whose entry is an executable on PATH, and asks for its file\'s content before it runs', async () => {
    onPath('acme-runtime');
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });

    expect(await open(team)).toEqual({
      ok: false,
      failure: {
        code: 'runtime_not_accepted',
        message: `Step runtime "acme" comes from the team repo (runtimes/acme.yaml, content ${sha(COMMAND_RUNTIME).slice(0, 12)}) and runs acme-runtime, which no one has accepted on this machine, and an unattended run does not ask. `
          + 'Run the same command once in a terminal, attended, to review and accept it, then run it unattended again.',
      },
    });
  });
});

describe('which runtime a name finds', () => {
  /** The runtime `use: acme` of `config` finds, as `{ layer, resource, location }`, after the person accepts it when asked. */
  async function located(config: LocalConfig, use = 'acme'): Promise<unknown> {
    const { locateRuntime, acceptRuntime } = await import('../workflow/runtimes/locate.js');
    const resolved = await resolveDriver(config, 'acme', { personal: true });
    if (!resolved.ok) return resolved.failure;
    const found = await locateRuntime(resolved.driver, use);
    if (!found.ok) return found.failure;
    const { source } = found;
    if (source.kind === 'builtin') return source;
    const accepted = await acceptRuntime(source, { mode: 'unattended', canAsk: false });
    return { layer: source.layer, resource: source.resource, location: source.location, form: source.marker.endsWith('RUNTIME.yaml') ? 'folder' : 'file', accepted: accepted.ok };
  }

  it('reads the member\'s own runtimes/<name>.yaml and runtimes/<name>/RUNTIME.yaml, which run with no acceptance', async () => {
    onPath('acme-runtime');
    personal({ 'runtimes/acme.yaml': COMMAND_RUNTIME, 'runtimes/mine/RUNTIME.yaml': 'protocol: 1\nentry: ./runtime\n', 'runtimes/mine/runtime': '#!/bin/sh\n' });
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });

    expect(await located(team)).toEqual({ layer: 'personal', resource: 'acme', location: path.join(getTeamaiHomeDir(), 'runtimes', 'acme.yaml'), form: 'file', accepted: true });
    expect(await located(team, 'mine')).toMatchObject({ layer: 'personal', resource: 'mine', form: 'folder', accepted: true });
  });

  it('reads a team folder runtimes/<name>/RUNTIME.yaml, and runs it once its revision is accepted', async () => {
    const team = teamWith({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ./bin/start\n', 'runtimes/acme/bin/start': '#!/bin/sh\n' });

    expect(await located(team)).toEqual({ layer: 'team', resource: 'acme', location: 'runtimes/acme/', form: 'folder', accepted: false });
  });

  it('runs a team file once a person accepts its content, and asks again once a teammate changes it', async () => {
    onPath('acme-runtime');
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });
    const { locateRuntime, acceptRuntime } = await import('../workflow/runtimes/locate.js');
    const resolved = await resolveDriver(team, 'acme', { personal: true });
    if (!resolved.ok) throw new Error(resolved.failure.message);
    const found = await locateRuntime(resolved.driver, 'acme');
    if (!found.ok) throw new Error(found.failure.message);
    const asked: string[] = [];

    expect(await acceptRuntime(found.source, { mode: 'attended', canAsk: true, ask: async (question) => { asked.push(question); return true; } })).toEqual({ ok: true });
    expect(asked).toEqual([`Step runtime "acme" comes from the team repo (runtimes/acme.yaml, content ${sha(COMMAND_RUNTIME).slice(0, 12)}), which you have not accepted on this machine. It runs acme-runtime as you, with your files. Review the file before you accept it.\nRun it? [y/N] `]);
    expect(await located(team)).toMatchObject({ layer: 'team', accepted: true });
    fs.writeFileSync(path.join(team.repo.localPath, 'runtimes', 'acme.yaml'), `${COMMAND_RUNTIME}exec: true\n`);
    expect(await located(team)).toMatchObject({ layer: 'team', accepted: false });
  });

  it('takes the exact name in every layer before teamai-<name>, and the member\'s before the team\'s', async () => {
    onPath('acme-runtime');
    personal({ 'runtimes/teamai-acme.yaml': COMMAND_RUNTIME });
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });

    expect(await located(team)).toMatchObject({ layer: 'team', resource: 'acme' });
    fs.rmSync(path.join(team.repo.localPath, 'runtimes', 'acme.yaml'));
    expect(await located(team)).toMatchObject({ layer: 'personal', resource: 'teamai-acme' });
  });

  it('reads a team runtime in a namespace the member\'s project selects for workflows, and not in one it does not', async () => {
    onPath('acme-runtime');
    const team = { ...teamWith({
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web] }\n  - id: billing\n    resources: { workflows: [mobile] }\n',
      'runtimes/web/acme.yaml': COMMAND_RUNTIME,
      'runtimes/mobile/other.yaml': COMMAND_RUNTIME,
    }), projects: ['checkout'] };

    expect(await located(team)).toMatchObject({ layer: 'team', location: 'runtimes/web/acme.yaml' });
    expect(await located(team, 'other')).toMatchObject({ code: 'runtime_not_found' });
  });
});
