import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { OpencodeAdapter } from './session-adapter.js';

/** OpenCode keeps its sessions behind its CLI, which teamai runs against its data directory. */
export const platforms = {
  'opencode': {
    store: { in: 'xdg-data', child: 'opencode' },
    resume: (id) => `opencode --session ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'task', 'todo_write', 'web_fetch', 'web_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'opencode',
    adapter: (storeDir, { processes }): AgentAdapter => new OpencodeAdapter(storeDir, processes),
    adapterAs: (platform, storeDir, { processes }): AgentAdapter => new OpencodeAdapter(storeDir, processes, platform),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
