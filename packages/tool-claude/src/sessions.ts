import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';

/** Each Claude build keeps Claude Code transcripts in its own home, so its sessions stay its own. */
export const platforms = {
  'claude-code': {
    store: { in: 'tool-home', home: 'claude', dir: 'projects' },
    resume: (id) => `claude --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir) => new ClaudeCodeAdapter('claude-code', storeDir),
    adapterAs: (platform, storeDir) => new ClaudeCodeAdapter(platform, storeDir),
  },
  'claude-internal': {
    store: { in: 'tool-home', home: 'claude-internal', dir: 'projects' },
    resume: (id) => `claude-internal --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir) => new ClaudeCodeAdapter('claude-internal', storeDir),
    adapterAs: (platform, storeDir) => new ClaudeCodeAdapter(platform, storeDir),
  },
  'tclaude': {
    store: { in: 'tool-home', home: 'tclaude', dir: 'projects' },
    resume: (id) => `tclaude --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir) => new ClaudeCodeAdapter('tclaude', storeDir),
    adapterAs: (platform, storeDir) => new ClaudeCodeAdapter(platform, storeDir),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
