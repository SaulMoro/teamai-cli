import { describe, expect, it } from 'vitest';
import { isCodexExecutable } from './sign-in.js';

describe('the Codex the daemon resolves', () => {
  it.each([
    ['win32', 'C:\\tools\\codex.exe', true],
    ['win32', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd', true],
    ['win32', 'C:\\Tools\\Codex.EXE', true],
    ['win32', 'C:\\tools\\codex', false],
    ['win32', 'C:\\tools\\codex.ps1', false],
    ['win32', 'C:\\tools\\helper.exe', false],
    ['win32', 'codex.exe', false],
    ['linux', '/usr/local/bin/codex', true],
    ['linux', '/usr/local/bin/codex.exe', false],
    ['darwin', '/opt/homebrew/bin/Codex', false],
  ] as const)('on %s, runs the Codex the daemon resolves to %s: %s', (platform, resolved, runs) => {
    expect(isCodexExecutable(resolved, platform)).toBe(runs);
  });
});
