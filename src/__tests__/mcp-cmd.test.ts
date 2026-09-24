import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
}));
vi.mock('../resources/mcp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resources/mcp.js')>()),
  resolveTeamMcpServers: vi.fn(),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn(),
  resolveMcpTargets: vi.fn().mockResolvedValue([]),
  buildVarTable: vi.fn().mockResolvedValue({}),
}));
vi.mock('../utils/fs.js', () => ({
  readJson: vi.fn().mockResolvedValue(null),
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { autoDetectInit } from '../config.js';
import { resolveTeamMcpServers } from '../resources/mcp.js';
import { mcpList } from '../mcp-cmd.js';

const mockedAutoDetectInit = autoDetectInit as Mock;
const mockedResolve = resolveTeamMcpServers as Mock;

/** A resolution as `resolveTeamMcpServers` returns it, from `[server, source, replaces]`. */
function resolved(entries: [Record<string, unknown>, string, string | null][]) {
  return {
    kind: 'resolved',
    active: [],
    notices: [],
    repeated: [],
    entries: entries.map(([entry, source, replaces]) => ({
      entry,
      name: entry.name,
      source,
      namespace: source === 'mcp/mcp.yaml' ? null : source.split('/')[1],
      replaces,
    })),
  };
}

async function listOutput(): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
  try {
    await mcpList({});
  } finally {
    spy.mockRestore();
  }
  return out.join('\n');
}

describe('mcpList', () => {
  beforeEach(() => {
    mockedAutoDetectInit.mockResolvedValue({
      localConfig: { repo: { localPath: '/repo' }, scope: 'user', additionalRoles: [] },
      teamConfig: { toolPaths: {} },
    });
  });

  it('prints where each server comes from, and says when a namespace overrides the root', async () => {
    mockedResolve.mockResolvedValue(resolved([
      [{ name: 'shared', transport: 'http', url: 'https://example.com/api/mcp' }, 'mcp/mcp.yaml', null],
      [{ name: 'db', transport: 'http', url: 'https://checkout.example.com/db' }, 'mcp/checkout/mcp.yaml', 'mcp/mcp.yaml'],
      [{ name: 'orders', transport: 'http', url: 'https://checkout.example.com/orders' }, 'mcp/checkout/mcp.yaml', null],
    ]));
    const text = await listOutput();
    expect(text).toContain('from:     mcp/mcp.yaml (root)');
    expect(text).toContain('from:     mcp/checkout/mcp.yaml (checkout, overrides root)');
    expect(text).toContain('from:     mcp/checkout/mcp.yaml (checkout)');
  });

  it('prints a deprecated roles restriction, and nothing for an unscoped server', async () => {
    mockedResolve.mockResolvedValue(resolved([
      [{ name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], roles: ['frontend'] }, 'mcp/mcp.yaml', null],
      [{ name: 'shared', transport: 'http', url: 'https://example.com/api/mcp' }, 'mcp/mcp.yaml', null],
    ]));
    const text = await listOutput();
    expect(text).toContain('playwright  [stdio]');
    expect(text).toContain('roles:    frontend (deprecated)');
    expect(text.match(/roles:/g)).toHaveLength(1);
  });

  it('reports a set that cannot be resolved instead of listing part of it', async () => {
    mockedResolve.mockResolvedValue({
      kind: 'failed',
      notices: [],
      failure: { kind: 'two-namespaces', type: 'mcp', name: 'db', first: 'mcp/checkout/mcp.yaml', second: 'mcp/billing/mcp.yaml' },
    });
    const { log } = await import('../utils/logger.js');
    await listOutput();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('server "db" is defined in both mcp/checkout/mcp.yaml and mcp/billing/mcp.yaml'));
    process.exitCode = 0;
  });
});
