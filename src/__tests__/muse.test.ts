import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileHooks } from '../hooks.js';

// The hooks contract of Muse Code 1.4.6, observed with the real binary and
// its SDK docs: a group carries only `matcher` and `hooks` (a group with any
// other key, such as Claude's `description`, is dropped with a warning), a
// handler only the keys below, and UserPromptSubmit and Stop accept no
// matcher other than `*`.
const MUSE_GROUP_KEYS = new Set(['matcher', 'hooks']);
const MUSE_HANDLER_KEYS = new Set([
  'type', 'command', 'timeout', 'statusMessage', 'async', 'onFailure', 'commandWindows', 'command_windows', 'outputCapabilities',
]);

interface MuseHookGroup { matcher?: string; hooks: Record<string, unknown>[] }
interface MuseSettings { schema_version?: number; hooks?: Record<string, MuseHookGroup[]>; [key: string]: unknown }

describe('Muse Code hooks', () => {
  let home: string;
  let settingsPath: string;

  beforeEach(async () => {
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-muse-hooks-'));
    settingsPath = path.join(home, '.config', 'muse', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));
  });

  afterEach(async () => {
    await fse.remove(home);
  });

  it('writes a settings.json Muse Code loads: schema_version 1 and only the hook keys it accepts', async () => {
    await reconcileHooks(settingsPath, 'muse');

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    expect(settings.schema_version).toBe(1);
    const events = settings.hooks ?? {};
    expect(Object.keys(events)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']));
    for (const [event, groups] of Object.entries(events)) {
      for (const group of groups) {
        expect(Object.keys(group).every((key) => MUSE_GROUP_KEYS.has(key)), `${event} group ${JSON.stringify(group)}`).toBe(true);
        if (event === 'UserPromptSubmit' || event === 'Stop') expect(group.matcher ?? '*').toBe('*');
        for (const handler of group.hooks) {
          expect(Object.keys(handler).every((key) => MUSE_HANDLER_KEYS.has(key)), JSON.stringify(handler)).toBe(true);
          expect(handler.command).toMatch(/teamai hook-dispatch \S+ --tool muse\b/);
        }
      }
    }
  });

  // Muse names its skill tool `read_skill`; a `Skill` matcher never fires there.
  it("runs the skill-usage hook on Muse's read_skill tool", async () => {
    await reconcileHooks(settingsPath, 'muse');

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    const skillGroups = (settings.hooks?.PostToolUse ?? [])
      .filter((group) => group.hooks.some((handler) => String(handler.command).includes('--matcher Skill')));
    expect(skillGroups.map((group) => group.matcher)).toEqual(['read_skill']);
  });

  it('keeps the rest of an existing settings.json and its schema_version', async () => {
    await fse.writeJson(settingsPath, {
      schema_version: 1,
      model: 'muse-spark-1.3',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });

    await reconcileHooks(settingsPath, 'muse');
    const first = await fse.readFile(settingsPath, 'utf8');
    await reconcileHooks(settingsPath, 'muse');

    expect(await fse.readFile(settingsPath, 'utf8')).toBe(first);
    const settings = JSON.parse(first) as MuseSettings;
    expect(settings.model).toBe('muse-spark-1.3');
    expect(settings.hooks?.SessionStart?.[0]).toEqual({ hooks: [{ type: 'command', command: 'echo mine' }] });
  });

  it('removeAll strips only the teamai entries', async () => {
    await fse.writeJson(settingsPath, {
      schema_version: 1,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });
    await reconcileHooks(settingsPath, 'muse');

    await reconcileHooks(settingsPath, 'muse', [], { removeAll: true });

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    expect(settings.schema_version).toBe(1);
    expect(JSON.stringify(settings)).not.toContain('teamai hook-dispatch');
    expect(settings.hooks?.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  });
});
