import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { injectHermesHooks, removeHermesHooks, getReportScriptPath, getInstructionsPluginDir } from '../hermes-hooks.js';
import { log } from '../utils/logger.js';

let tmpDir: string;
let savedHermesHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-hooks-test-'));
  savedHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = tmpDir;
});

afterEach(() => {
  if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHermesHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('injectHermesHooks', () => {
  it('reports the injection only when the script, hook entry or allowlist changes', async () => {
    const success = vi.spyOn(log, 'success').mockImplementation(() => {});
    try {
      await injectHermesHooks();
      expect(fs.existsSync(getReportScriptPath())).toBe(true);
      expect(success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai Hermes hook'));
      success.mockClear();

      await injectHermesHooks();
      expect(success).not.toHaveBeenCalled();
    } finally {
      success.mockRestore();
    }
  });
});

describe('the teamai-instructions plugin (#945)', () => {
  const config = () => fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');

  it('installs the plugin and enables it beside the member\'s own plugins, then removes both', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), '# mine\nplugins:\n  enabled:\n    - disk-cleanup\n');
    vi.spyOn(log, 'success').mockImplementation(() => {});

    await injectHermesHooks();
    expect(fs.readFileSync(path.join(getInstructionsPluginDir(), '__init__.py'), 'utf8')).toContain('register_system_prompt_section');
    expect(fs.readFileSync(path.join(getInstructionsPluginDir(), 'plugin.yaml'), 'utf8')).toContain('name: teamai-instructions');
    expect(config()).toContain('# mine');
    expect(config()).toMatch(/- disk-cleanup\n\s+- teamai-instructions/);

    await removeHermesHooks();
    expect(fs.existsSync(getInstructionsPluginDir())).toBe(false);
    expect(config()).toContain('- disk-cleanup');
    expect(config()).not.toContain('teamai-instructions');
  });

  it('leaves the plugin off when the member disabled it', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'plugins:\n  disabled:\n    - teamai-instructions\n');
    vi.spyOn(log, 'success').mockImplementation(() => {});

    await injectHermesHooks();

    expect(config()).not.toMatch(/enabled:/);
  });
});
