import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { AgyAdapter, agyStoreRoots } from './session-adapter.js';

/** agy keeps its conversations beside its config root, and the Antigravity app its own beside them; teamai reads them and writes none. */
export const platforms = {
  'agy': {
    // agy 1.4.8 keeps its conversations beside its config root: ~/.gemini/antigravity-cli.
    store: { in: 'tool-home', home: 'agy', dir: '../antigravity-cli' },
    resume: (id) => `agy --conversation ${id}`,
    thinking: true, images: false,
    nativeTools: new Set(['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'web_search', 'web_fetch', 'task']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    adapter: (storeDir): AgentAdapter => new AgyAdapter(agyStoreRoots(storeDir)),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
