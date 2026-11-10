import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { CursorAdapter } from './session-adapter.js';

/** Cursor keeps the CLI's transcripts in its home, and registers the IDE's composers in its state database. */
export const platforms = {
  'cursor': {
    // The Cursor CLI's transcripts move with CURSOR_DATA_DIR, recorded under its own root (RELOCATABLE_TOOLS).
    store: { in: 'tool-home', home: 'cursor', dir: 'projects', root: 'cursor-data' },
    resume: (id) => `cursor-agent --resume ${id}`,
    thinking: false, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'delete_file',
      'web_fetch', 'web_search', 'semantic_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: true,
    idFormat: 'uuid',
    adapter: (storeDir, { processes }): AgentAdapter => new CursorAdapter('cursor', storeDir, processes),
    adapterAs: (platform, storeDir, { processes }): AgentAdapter => new CursorAdapter(platform, storeDir, processes),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
