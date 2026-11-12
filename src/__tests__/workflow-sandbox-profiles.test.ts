import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDriverDefinition, resolveDriver } from '../workflow/runtimes/definitions.js';
import { folderRevision } from '../workflow/runtimes/resource-folder.js';
import { locateSandboxProfile } from '../workflow/runtimes/sandbox-profiles.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';
import { buildSandboxProfileChecks } from '../doctor-sandboxes.js';

/**
 * A sandbox profile as a resource: `sandboxes/<name>.yaml`, or a folder `sandboxes/<name>/` with its `SANDBOX.yaml` and
 * what it builds from, of the member, the team or teamai, found as a driver's `sandbox:` names it.
 */

const dirs: string[] = [];

afterEach(() => {
  fs.rmSync(path.join(getTeamaiHomeDir(), 'sandboxes'), { recursive: true, force: true });
  fs.rmSync(path.join(getTeamaiHomeDir(), 'runtimes'), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A user-scope config whose team repo holds `files`, and its definition `boxed` on the sandbox runtime. */
async function teamWith(files: Record<string, string>): Promise<{ config: LocalConfig; at: (file: string) => string; locate: (name?: string) => ReturnType<typeof locateSandboxProfile> }> {
  const team = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-profiles-')));
  dirs.push(team);
  const at = (file: string): string => path.join(team, file);
  for (const [file, text] of Object.entries({ 'drivers/boxed.yaml': 'schemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: sandbox\n', ...files })) {
    fs.mkdirSync(path.dirname(at(file)), { recursive: true });
    fs.writeFileSync(at(file), text);
  }
  const config: LocalConfig = { repo: { localPath: team, remote: 'origin', kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [] };
  const resolved = await resolveDriver(config, 'boxed', { personal: true });
  if (!resolved.ok) throw new Error(resolved.failure.message);
  return { config, at, locate: (name) => locateSandboxProfile(resolved.driver, name) };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const DOCKER = 'provider: docker\nimage: ghcr.io/acme/agent:1\n';

describe('which sandbox profile a name finds', () => {
  it('reads a team sandboxes/<name>.yaml at its content', async () => {
    const { locate } = await teamWith({ 'sandboxes/gpu.yaml': DOCKER });

    expect(await locate('gpu')).toEqual({ ok: true, profile: { asked: 'gpu', resource: 'gpu', layer: 'team', location: 'sandboxes/gpu.yaml', revision: sha(DOCKER), options: { provider: 'docker', image: 'ghcr.io/acme/agent:1' } } });
  });

  it('reads a team folder sandboxes/<name>/SANDBOX.yaml at the folder\'s revision, and gives the folder its paths are inside', async () => {
    const { locate, at } = await teamWith({ 'sandboxes/gpu/SANDBOX.yaml': `${DOCKER}warm: { containerfile: ./Containerfile, cache: [package.json] }\n`, 'sandboxes/gpu/Containerfile': 'FROM ghcr.io/acme/agent:1\n' });

    expect(await locate('gpu')).toEqual({
      ok: true,
      profile: {
        asked: 'gpu', resource: 'gpu', layer: 'team', location: 'sandboxes/gpu/', folder: at('sandboxes/gpu'), revision: await folderRevision(at('sandboxes/gpu')),
        options: { provider: 'docker', image: 'ghcr.io/acme/agent:1', warm: { containerfile: './Containerfile', cache: ['package.json'] } },
      },
    });
  });

  it('takes profile default, then teamai\'s teamai-default, when the entry names none', async () => {
    const { locate } = await teamWith({});

    expect(await locate(undefined)).toMatchObject({ ok: true, profile: { asked: 'default', resource: 'teamai-default', layer: 'teamai', location: 'teamai\'s sandboxes/teamai-default.yaml', options: { provider: 'sbx' } } });
  });

  it('takes the member\'s own profile over the team\'s, and says which of teamai\'s a profile of the member or the team replaces', async () => {
    const { locate } = await teamWith({ 'sandboxes/default.yaml': DOCKER, 'sandboxes/gpu.yaml': DOCKER });
    fs.mkdirSync(path.join(getTeamaiHomeDir(), 'sandboxes'), { recursive: true });
    fs.writeFileSync(path.join(getTeamaiHomeDir(), 'sandboxes', 'gpu.yaml'), 'provider: seatbelt\n');

    expect(await locate('gpu')).toMatchObject({ ok: true, profile: { layer: 'personal', options: { provider: 'seatbelt' } } });
    expect(await locate('gpu')).not.toHaveProperty('profile.replaces');
    expect(await locate(undefined)).toMatchObject({ ok: true, profile: { layer: 'team', resource: 'default', replaces: 'teamai-default' } });
  });

  it('fails when no layer holds the profile, naming the file to add', async () => {
    const { locate } = await teamWith({});

    expect(await locate('gpu')).toEqual({ ok: false, failure: {
      code: 'sandbox_profile_not_found',
      message: 'Driver "boxed" runs its sandbox with profile "gpu", and none is declared: add sandboxes/gpu.yaml (or sandboxes/gpu/SANDBOX.yaml with what it builds from) to the team repo and run teamai pull, or add ~/.teamai/sandboxes/gpu.yaml for yourself.',
    } });
  });
});

describe('a sandbox profile that cannot be used', () => {
  const refused = (location: string, reason: string) => ({ ok: false, failure: {
    code: 'sandbox_profile_invalid',
    message: `Driver "boxed" runs its sandbox with profile "gpu", and ${location} cannot be used: ${reason}. Fix it, push it, run teamai pull, and start again.`,
  } });

  it('fails on a profile that is not YAML or not a mapping, and never takes another layer\'s', async () => {
    fs.mkdirSync(path.join(getTeamaiHomeDir(), 'sandboxes'), { recursive: true });
    fs.writeFileSync(path.join(getTeamaiHomeDir(), 'sandboxes', 'teamai-gpu.yaml'), DOCKER);

    expect(await (await teamWith({ 'sandboxes/gpu.yaml': 'provider: [docker\n' })).locate('gpu')).toMatchObject({ ok: false, failure: { code: 'sandbox_profile_invalid', message: expect.stringContaining('sandboxes/gpu.yaml cannot be used: it is not YAML') } });
    expect(await (await teamWith({ 'sandboxes/gpu.yaml': '- docker\n' })).locate('gpu')).toEqual(refused('sandboxes/gpu.yaml', 'it sets no options, and a profile is a mapping such as provider: docker'));
  });

  it('fails on a profile that sets max_parallel or credentials, which stay on the driver\'s entry', async () => {
    expect(await (await teamWith({ 'sandboxes/gpu.yaml': `${DOCKER}max_parallel: 2\n` })).locate('gpu'))
      .toEqual(refused('sandboxes/gpu.yaml', 'it sets max_parallel, which the driver definition\'s entry sets, as its options: { max_parallel: 2 }'));
  });

  it('fails on a team folder that holds a link, or a sandboxes folder that is a link', async () => {
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-outside-')));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'Containerfile'), 'FROM elsewhere\n');
    const linked = await teamWith({ 'sandboxes/gpu/SANDBOX.yaml': DOCKER });
    fs.symlinkSync(path.join(outside, 'Containerfile'), linked.at('sandboxes/gpu/Containerfile'));

    expect(await linked.locate('gpu')).toEqual(refused('sandboxes/gpu/', 'it holds the link Containerfile, and teamai builds a sandbox only from what the folder itself holds'));

    const whole = await teamWith({});
    fs.mkdirSync(path.join(outside, 'gpu'));
    fs.writeFileSync(path.join(outside, 'gpu.yaml'), DOCKER);
    fs.symlinkSync(outside, whole.at('sandboxes'));
    expect(await whole.locate('gpu')).toEqual({ ok: false, failure: {
      code: 'sandbox_profile_invalid',
      message: 'Driver "boxed" runs its sandbox with profile "gpu", and sandboxes in the team repo is a link, and teamai reads a team sandbox profile only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.',
    } });
  });
});

describe('the sandbox key of a runtime entry', () => {
  it('names a profile only on use: sandbox or through: sandbox', () => {
    expect(parseDriverDefinition('drivers/boxed.yaml', 'schemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: sandbox\n    sandbox: gpu\n')).toMatchObject({ ok: true, definition: { runtimes: [{ use: 'sandbox', sandbox: 'gpu' }] } });
    expect(parseDriverDefinition('drivers/boxed.yaml', 'schemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: t3\n    through: sandbox\n    sandbox: gpu\n')).toMatchObject({ ok: true });
    expect(parseDriverDefinition('drivers/boxed.yaml', 'schemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: t3\n    sandbox: gpu\n')).toEqual({ ok: false, failure: {
      code: 'driver_invalid',
      message: 'Driver definition drivers/boxed.yaml is not valid: runtimes.0.sandbox: sandbox names a sandbox profile, which only an entry with use: sandbox or through: sandbox runs. Fix the file and start again.',
    } });
  });
});

describe('what doctor says of the sandbox profiles of the drivers in use', () => {
  // Stands in for the sandbox runtime's check: its provider's engine is down for docker, and answers for any other.
  const CHECKING_RUNTIME = [
    '#!/bin/sh',
    'read -r line',
    'case "$line" in',
    '  *\'"provider":"docker"\'*) echo \'{"type":"init","ok":false,"error":{"code":"sandbox_unavailable","message":"docker is installed, but its daemon is not running"}}\' ;;',
    '  *) echo \'{"type":"init","ok":false,"error":{"code":"check_unsupported","message":"The sandbox runtime cannot tell more"}}\' ;;',
    'esac',
    '',
  ].join('\n');

  it('lists each sandbox entry of the default driver and of the ones the member tunes, with its profile, and whether this machine can start it', async () => {
    const { config } = await teamWith({
      'drivers/boxed.yaml': 'schemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: sandbox\n    sandbox: gpu\n  - use: sandbox\n    sandbox: missing\n  - use: tools\n',
      'drivers/native.yaml': 'schemaVersion: v1alpha1\nname: native\nruntimes:\n  - use: sandbox\n    sandbox: mac\n',
      'drivers/plain.yaml': 'schemaVersion: v1alpha1\nname: plain\nruntimes:\n  - use: tools\n',
      'sandboxes/gpu.yaml': DOCKER,
      'sandboxes/mac.yaml': 'provider: seatbelt\n',
    });
    const runtime = path.join(getTeamaiHomeDir(), 'runtimes', 'sandbox');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'RUNTIME.yaml'), 'protocol: 1\nentry: ./runtime\n');
    fs.writeFileSync(path.join(runtime, 'runtime'), CHECKING_RUNTIME, { mode: 0o755 });

    const checks = await buildSandboxProfileChecks({ localConfig: { ...config, workflows: { tools: {}, drivers: { native: { runtimes: {} }, plain: { runtimes: {} } } } }, teamConfig: { workflows: { driver: 'boxed' } } }, config.repo.localPath);
    const results = await Promise.all(checks.map(async ({ name, check, fix }) => ({ name, passed: await check(), fix })));

    expect(results).toEqual([
      {
        name: `Sandbox profile "gpu" of driver boxed (sandboxes/gpu.yaml, revision ${sha(DOCKER).slice(0, 12)}, provider docker) can start here`,
        passed: false,
        fix: expect.stringContaining('(sandbox_unavailable): docker is installed, but its daemon is not running'),
      },
      {
        name: 'Sandbox profile "missing" of driver boxed is declared',
        passed: false,
        fix: 'Driver "boxed" runs its sandbox with profile "missing", and none is declared: add sandboxes/missing.yaml (or sandboxes/missing/SANDBOX.yaml with what it builds from) to the team repo and run teamai pull, or add ~/.teamai/sandboxes/missing.yaml for yourself.',
      },
      {
        name: `Sandbox profile "mac" of driver native (sandboxes/mac.yaml, revision ${sha('provider: seatbelt\n').slice(0, 12)}, provider seatbelt) can start here`,
        passed: true,
        fix: undefined,
      },
    ]);
  });
});
