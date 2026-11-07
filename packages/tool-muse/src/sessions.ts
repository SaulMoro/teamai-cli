import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { MuseAdapter } from './session-adapter.js';

/** Muse Code keeps its sessions under the XDG data home; teamai reads them and writes none. */
export const platforms = {
  muse: {
    // Muse 1.4.x: ${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<id>/session.jsonl.
    store: { in: 'xdg-data', child: 'muse/sessions' },
    resume: (id) => `muse resume ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'bash', 'read_file', 'write_file', 'edit_file', 'search', 'web_search',
      'read_memory', 'add_memory', 'edit_memory', 'todo_write', 'task',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    adapter: (storeDir): AgentAdapter => new MuseAdapter(storeDir),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
