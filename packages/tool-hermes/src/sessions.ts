import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { HermesAdapter } from './session-adapter.js';

/** Hermes keeps every profile's sessions in one SQLite store in its home; teamai reads them and writes none. */
export const platforms = {
  hermes: {
    // Hermes Agent stores every profile's sessions in <Hermes home>/state.db; source identifies the surface.
    store: { in: 'tool-home', home: 'hermes', dir: '.' },
    resume: (id) => `hermes -c ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'terminal', 'read_file', 'write_file', 'patch', 'search_files', 'delegate_task',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'hermes',
    readOnly: true,
    adapter: (storeDir, { processes }): AgentAdapter => new HermesAdapter(storeDir, processes),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
