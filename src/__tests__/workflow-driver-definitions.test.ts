import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDriverDefinition, resolveDriver } from '../workflow/runtimes/definitions.js';
import { openDriver } from '../workflow/runtimes/sources.js';
import { shippedDriverFile } from '../default-drivers.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

  it('reads no definition of the member\'s own where personal ones do not count, and does not tell the member to add one there', async () => {
    const team = teamWith([]);
    fs.mkdirSync(path.join(getTeamaiHomeDir(), 'drivers'), { recursive: true });
    fs.writeFileSync(path.join(getTeamaiHomeDir(), 'drivers', 'my_box.yaml'), definition('my_box'));

    expect(await resolveDriver(team, 'my_box', { personal: false })).toEqual({ ok: false, failure: {
      code: 'driver_not_found',
      message: 'No driver definition of the team or teamai is named "my_box", and a definition in ~/.teamai/drivers/ does not count here. Add drivers/my_box.yaml to the team repo and run teamai pull, or use --driver local.',
    } });
  });

  it.each(['none', 'skill', 'fleet'])('refuses a definition named %s, a name teamai keeps for its own driver', async (name) => {
    const team = teamWith([name]);

    expect(parseDriverDefinition(`drivers/${name}.yaml`, definition(name))).toMatchObject({ ok: false, failure: { code: 'driver_invalid' } });
    expect(await resolveDriver(team, name, { personal: true })).toMatchObject({ ok: false, failure: { code: 'driver_not_found', message: expect.stringContaining(`"${name}"`) } });
  });
});

describe('the local driver, which is the definition teamai-local', () => {
  const open = (config: LocalConfig, name: string) => openDriver(config, name, { personal: true, mode: 'unattended', canAsk: false, purpose: 'run', checkout: config.repo.localPath });

  it('opens the shipped teamai-local for --driver local, a definition of the tools runtime alone that names no tool', async () => {
    const opened = await open(teamWith([]), 'local');

    expect(opened).toMatchObject({ ok: true, opened: { asked: 'local', driver: { name: 'teamai-local', source: 'shipped', definition: { runtimes: [{ use: 'tools' }] } }, runtimes: [{ kind: 'tools', use: 'tools' }] } });
    expect(opened.ok && opened.opened.driver.definition.tool).toBeUndefined();
  });

  it('takes a member\'s ~/.teamai/drivers/teamai-local.yaml for --driver local over the team\'s, and says once which file it took', async () => {
    const team = teamWith(['teamai-local']);
    const file = path.join(getTeamaiHomeDir(), 'drivers', 'teamai-local.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'schemaVersion: v1alpha1\nname: teamai-local\ntool: codex\nruntimes:\n  - use: tools\n');
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    expect(await open(team, 'local')).toMatchObject({ ok: true, opened: { driver: { source: 'personal', file, definition: { tool: 'codex' } } } });
    expect(info.mock.calls.map(([line]) => line)).toEqual([`Driver local runs ${file}, your own teamai-local, in place of teamai's.`]);
  });

  it('takes the team\'s drivers/teamai-local.yaml for --driver local, and says so', async () => {
    const team = teamWith(['teamai-local']);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    expect(await open(team, 'local')).toMatchObject({ ok: true, opened: { driver: { source: 'team' } } });
    expect(info.mock.calls.map(([line]) => line)).toEqual([`Driver local runs ${path.join(team.repo.localPath, 'drivers', 'teamai-local.yaml')}, the team's teamai-local, in place of teamai's.`]);
  });

  it('refuses a definition named local, and never reads a team\'s drivers/local.yaml for --driver local', async () => {
    const team = teamWith(['local']);

    expect(parseDriverDefinition('drivers/local.yaml', definition('local'))).toMatchObject({ ok: false, failure: { code: 'driver_invalid' } });
    expect(await resolveDriver(team, 'local', { personal: true })).toMatchObject({ ok: true, driver: { name: 'teamai-local', source: 'shipped' } });
  });

  it('runs a definition\'s use: local as the tools runtime, and logs nothing for it', async () => {
    const team = teamWith(['mine']);
    const said = [vi.spyOn(log, 'warn').mockImplementation(() => {}), vi.spyOn(log, 'info').mockImplementation(() => {})];

    expect(await open(team, 'mine')).toMatchObject({ ok: true, opened: { runtimes: [{ kind: 'tools' }] } });
    expect(said.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });

  it('ships each preset on the tools runtime, and none of an app with a fallback to this machine', () => {
    const runtimes = (name: string): unknown => {
      const parsed = parseDriverDefinition(`${name}.yaml`, fs.readFileSync(shippedDriverFile(name), 'utf8'));

      return parsed.ok ? { tool: parsed.definition.tool, uses: parsed.definition.runtimes.map((entry) => entry.use) } : parsed.failure.message;
    };

    expect(Object.fromEntries(['teamai-local', 'teamai-claude', 'teamai-codex', 'teamai-opencode', 'teamai-t3', 'teamai-paseo', 'teamai-sandbox'].map((name) => [name, runtimes(name)]))).toEqual({
      'teamai-local': { tool: undefined, uses: ['tools'] },
      'teamai-claude': { tool: 'claude', uses: ['tools'] },
      'teamai-codex': { tool: 'codex', uses: ['tools'] },
      'teamai-opencode': { tool: 'opencode', uses: ['tools'] },
      'teamai-t3': { tool: undefined, uses: ['t3'] },
      'teamai-paseo': { tool: undefined, uses: ['paseo'] },
      'teamai-sandbox': { tool: undefined, uses: ['sandbox', 'tools'] },
    });
  });
});

describe('a runtime through another in a definition', () => {
  const through = (use: string, by: string): string => `schemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: ${use}\n    through: ${by}\n    options:\n      ${use}: {}\n`;

  it('reads a runtime through another, each one\'s options under its name', () => {
    expect(parseDriverDefinition('drivers/boxed.yaml', through('t3', 'sandbox'))).toMatchObject({ ok: true, definition: { runtimes: [{ use: 't3', through: 'sandbox', options: { t3: {} } }] } });
  });

  it('refuses a runtime through itself, naming through', () => {
    expect(parseDriverDefinition('drivers/boxed.yaml', through('sandbox', 'sandbox'))).toMatchObject({ ok: false, failure: { code: 'driver_invalid', message: expect.stringContaining('runtimes.0.through: A runtime runs through another runtime, not through itself') } });
  });
});
