import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCursorStateRoot } from './cursor-store.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the IDE store root', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('honors XDG_CONFIG_HOME on Linux, as ide-history does', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const xdg = path.join(os.tmpdir(), 'teamai-cursor-xdg');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    expect(getCursorStateRoot()).toBe(path.join(xdg, 'Cursor'));

    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    // `os.homedir()`, which is what cursor-store reads.
    expect(getCursorStateRoot()).toBe(path.join(os.homedir(), '.config', 'Cursor'));
  });

  it('treats a blank XDG_CONFIG_HOME as unset, not as the working directory', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('XDG_CONFIG_HOME', '');
    // `??` would keep the empty string, leaving the result a relative `Cursor`.
    expect(getCursorStateRoot()).toBe(path.join(os.homedir(), '.config', 'Cursor'));
  });
});
