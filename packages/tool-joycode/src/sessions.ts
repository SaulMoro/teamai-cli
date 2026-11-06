import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';

/** JoyCode keeps Codex rollouts in its own home. */
export const platforms = {
  'joycode': {
    store: { in: 'tool-home', home: 'joycode', dir: 'sessions' },
    resume: (id) => `joycode --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir) => new CodexAdapter('joycode', storeDir),
    adapterAs: (platform, storeDir) => new CodexAdapter(platform, storeDir),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
