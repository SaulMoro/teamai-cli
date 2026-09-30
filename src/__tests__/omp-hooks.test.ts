import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import fse from 'fs-extra';

/** Assert a generated ESM extension body parses as valid JS (strip the bun
 *  import — vm.Script is not an ESM context — and `export default`). */
function assertValidJs(src: string): void {
  const body = src.replace(/^import .*;$/gm, '').replace(/export default /g, 'const __x = ');
  expect(() => new vm.Script(body)).not.toThrow();
}

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import {
  resolveOmpExtensionsDir,
  injectOmpHooks,
  removeOmpHooks,
  buildOmpExtensionSource,
  OMP_HOOK_FILE,
} from '../omp-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { log } from '../utils/logger.js';
import { loadOmpExtension } from './helpers/pi-extensions.js';

describe('resolveOmpExtensionsDir', () => {
  it('always targets the user agent dir (single-copy policy)', () => {
    expect(resolveOmpExtensionsDir()).toBe(
      path.join(os.homedir(), '.omp', 'agent', 'extensions'),
    );
  });
});

describe('buildOmpExtensionSource', () => {
  const src = buildOmpExtensionSource();
  it('maps the four Claude built-in events to OMP events and teamai dispatch', () => {
    expect(src).toContain('pi.on("session_start"');
    expect(src).toContain('dispatch("session-start"');
    expect(src).toContain('pi.on("session_stop"');
    expect(src).toContain('dispatch("stop"');
    expect(src).toContain('pi.on("before_agent_start"');
    expect(src).toContain('dispatch("prompt-submit"');
    expect(src).toContain('pi.on("tool_result"');
    expect(src).toContain('dispatch("post-tool-use"');
  });
  it('shells out to teamai hook-dispatch --tool omp, swallowing errors', () => {
    expect(src).toContain('"hook-dispatch"');
    expect(src).toContain('"--tool", "omp"');
    expect(src).toContain('.quiet().nothrow()');
    expect(src).toContain('} catch {');
  });
  it('forwards a STDIN payload (cwd + per-event fields) via a Response', () => {
    // cwd comes from the extension ctx, fed on STDIN so the provider-config
    // gate and track/hint handlers work.
    expect(src).toContain('JSON.stringify({ cwd');
    expect(src).toContain('new Response(stdin)');
    expect(src).toContain('ctx.cwd');
    expect(src).toContain('event.prompt');
    expect(src).toContain('tool_name');
    expect(src).toContain('tool_input');
  });
  it('returns nothing from session_stop (never forces a continuation)', () => {
    // SessionStopEventResult's `continue` / `decision: "block"` fields would
    // change OMP's own stop semantics — the handler must stay side-effect only.
    expect(src).not.toContain('continue:');
    expect(src).not.toContain('decision:');
    expect(src).toContain('session_stop');
  });
  it('runs no matcher-scoped pass (no PascalCase tool mapping)', () => {
    // OMP tool ids are lowercase (bash / read / …) and it has no Skill /
    // TodoWrite tool; the TodoWrite hint's STDOUT has no way back into OMP.
    expect(src).not.toContain('--matcher');
    expect(src).not.toContain("'Skill'");
    expect(src).not.toContain("'TodoWrite'");
  });
  it('carries the [teamai] marker for doctor / uninstall recognition', () => {
    expect(src).toContain('// [teamai] hooks extension');
  });
  it('is syntactically valid JavaScript', () => {
    assertValidJs(src);
  });
});

describe('injectOmpHooks / removeOmpHooks', () => {
  let tmp: string;
  let prevHome: string | undefined;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-hooks-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fse.remove(tmp);
  });
  const extFile = () => path.join(tmp, '.omp', 'agent', 'extensions', OMP_HOOK_FILE);

  it('writes ~/.omp/agent/extensions/teamai-hooks.ts with the marker', async () => {
    await injectOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(true);
    expect(await fse.readFile(extFile(), 'utf8')).toContain('[teamai] hooks extension');
  });

  it('is idempotent — re-inject produces identical bytes', async () => {
    await injectOmpHooks();
    const first = await fse.readFile(extFile(), 'utf8');
    await injectOmpHooks();
    expect(await fse.readFile(extFile(), 'utf8')).toBe(first);
  });

  it('reports the injection only when the extension changes', async () => {
    await injectOmpHooks();
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai OMP hook'));
    vi.mocked(log.success).mockClear();

    await injectOmpHooks();
    expect(log.success).not.toHaveBeenCalled();
  });

  it('remove deletes the extension file; safe when absent', async () => {
    await removeOmpHooks(); // no-op, no throw
    await injectOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(true);
    await removeOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(false);
  });
});

describe('reconcileHooksToAllTools routes omp to the extension adapter', () => {
  let tmp: string;
  let home: string;
  let projectRoot: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-recon-'));
    home = path.join(tmp, 'home');
    projectRoot = path.join(tmp, 'project');
    await fse.ensureDir(home);
    await fse.ensureDir(projectRoot);
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fse.remove(tmp);
  });

  const toolPaths = { omp: { skills: '.omp/skills' } } as Record<string, { settings?: string }>;
  const manifest = () => path.join(tmp, 'managed-hooks.json');
  const extFile = () => path.join(home, '.omp', 'agent', 'extensions', OMP_HOOK_FILE);

  it('does nothing when OMP is not installed (no ~/.omp)', async () => {
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(path.join(home, '.omp'))).toBe(false);
  });

  it('injects the single user-root extension when ~/.omp exists', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
  });

  it('injects into the user root even when reconciling a project-scope base dir', async () => {
    // OMP would load a project copy (~/.omp aside, <project>/.omp/extensions)
    // alongside the user one and dispatch every event twice — the adapter must
    // keep exactly one copy, in HOME.
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
    expect(await fse.pathExists(path.join(projectRoot, '.omp', 'extensions', OMP_HOOK_FILE))).toBe(false);
  });

  it('removeAll deletes the extension', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { removeAll: true });
    expect(await fse.pathExists(extFile())).toBe(false);
  });

  it('settingsOnly skips the omp adapter', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { settingsOnly: true });
    expect(await fse.pathExists(extFile())).toBe(false);
  });
});

// Recall attribution (#884): the extension evaluated in `vm`, with a fake host.
describe('OMP extension: bridge payloads (#884)', () => {
  const main = { cwd: '/work/proj', sessionManager: { getSessionId: () => 'omp-main' }, agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 } };
  const sub = {
    cwd: '/work/proj', sessionManager: { getSessionId: () => 'omp-sub' },
    agent: { kind: 'sub' as const, id: '0-TeamaiRecall', name: 'teamai-recall', depth: 1, parentId: 'Main' },
  };

  it('sends the host session id on every lifecycle event, and no agent fields for the main agent', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.session_start({}, main);
    await on.before_agent_start({ prompt: 'hi' }, main);
    await on.session_stop({}, main);
    expect(dispatches.map((d) => [d.args[1], d.payload])).toEqual([
      ['session-start', { cwd: '/work/proj', session_id: 'omp-main' }],
      ['prompt-submit', { cwd: '/work/proj', session_id: 'omp-main', prompt: 'hi' }],
      ['stop', { cwd: '/work/proj', session_id: 'omp-main' }],
    ]);
    expect(dispatches.every((d) => d.args.join(' ').endsWith('--tool omp'))).toBe(true);
  });

  it('sends the text output and the status on post-tool-use', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.tool_result({ type: 'tool_result', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' },
      content: [{ type: 'text', text: 'a.md' }, { type: 'image', data: 'AAAA' }, { type: 'text', text: 'b.md' }], isError: false }, main);
    await on.tool_result({ type: 'tool_result', toolCallId: 'c2', toolName: 'bash', input: { command: 'false' },
      content: [{ type: 'text', text: 'Command exited with code 1' }], isError: true }, main);
    expect(dispatches.map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', session_id: 'omp-main', tool_name: 'bash', tool_input: { command: 'ls' }, tool_response: 'a.md\nb.md', tool_status: 'success' },
      { cwd: '/work/proj', session_id: 'omp-main', tool_name: 'bash', tool_input: { command: 'false' }, tool_response: 'Command exited with code 1', tool_status: 'failure' },
    ]);
  });

  it('sends a subagent\'s agent id and type on its events', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.session_start({}, sub);
    await on.tool_result({ type: 'tool_result', toolCallId: 'c1', toolName: 'read', input: { path: 'x.md' }, content: [], isError: false }, sub);
    await on.session_stop({}, sub);
    expect(dispatches.map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', session_id: 'omp-sub', agent_id: '0-TeamaiRecall', agent_type: 'teamai-recall' },
      { cwd: '/work/proj', session_id: 'omp-sub', agent_id: '0-TeamaiRecall', agent_type: 'teamai-recall', tool_name: 'read', tool_input: { path: 'x.md' }, tool_response: '', tool_status: 'success' },
      { cwd: '/work/proj', session_id: 'omp-sub', agent_id: '0-TeamaiRecall', agent_type: 'teamai-recall' },
    ]);
  });

  it('still dispatches on an older host with no ctx.agent (below 18.3.2), no session manager and no result fields', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.session_start({}, { cwd: '/work/proj', sessionManager: { getSessionId: () => 'omp-old' } });
    await on.tool_result({ toolName: 'read', input: { path: 'x.md' } }, { cwd: '/work/proj' });
    expect(dispatches.map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', session_id: 'omp-old' },
      { cwd: '/work/proj', tool_name: 'read', tool_input: { path: 'x.md' }, tool_status: 'unknown' },
    ]);
  });
});
