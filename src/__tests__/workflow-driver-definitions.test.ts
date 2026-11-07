import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDriverDefinition, resolveDriver } from '../workflow/runtimes/definitions.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  fs.rmSync(path.join(getTeamaiHomeDir(), 'drivers'), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const definition = (name: string): string => `schemaVersion: v1alpha1\nname: ${name}\nruntimes:\n  - use: local\n`;

/** A config in `scope` whose team repo holds a definition for each of `names` under drivers/. */
function teamWith(names: string[], scope: LocalConfig['scope'] = 'user'): LocalConfig {
  const team = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-driver-definitions-')));
  dirs.push(team);
  fs.mkdirSync(path.join(team, 'drivers'));
  for (const name of names) fs.writeFileSync(path.join(team, 'drivers', `${name}.yaml`), definition(name));
  return { repo: { localPath: team, remote: 'origin', kind: 'git' }, username: 'tester', scope, additionalRoles: [], ...(scope === 'project' && { projectRoot: team }) };
}

describe('driver definition names', () => {
  it('loads a definition with an ordinary name from the team repo, from ~/.teamai/drivers/, and from a project\'s own team repo', async () => {
    const team = teamWith(['acme-sandbox']);
    const project = teamWith(['payments.ci'], 'project');
    fs.mkdirSync(path.join(getTeamaiHomeDir(), 'drivers'), { recursive: true });
    fs.writeFileSync(path.join(getTeamaiHomeDir(), 'drivers', 'my_box.yaml'), definition('my_box'));

    expect(await resolveDriver(team, 'acme-sandbox', { personal: true })).toMatchObject({ ok: true, driver: { name: 'acme-sandbox', source: 'team' } });
    expect(await resolveDriver(team, 'my_box', { personal: true })).toMatchObject({ ok: true, driver: { name: 'my_box', source: 'personal' } });
    expect(await resolveDriver(project, 'payments.ci', { personal: true })).toMatchObject({ ok: true, driver: { name: 'payments.ci', source: 'team' } });
  });

  it.each(['none', 'local', 'skill', 'fleet'])('refuses a definition named %s, a name teamai keeps for its own driver', async (name) => {
    const team = teamWith([name]);

    expect(parseDriverDefinition(`drivers/${name}.yaml`, definition(name))).toMatchObject({ ok: false, failure: { code: 'driver_invalid' } });
    expect(await resolveDriver(team, name, { personal: true })).toMatchObject({ ok: false, failure: { code: 'driver_not_found', message: expect.stringContaining(`"${name}"`) } });
  });
});
