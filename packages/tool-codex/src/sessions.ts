import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';

/** Each Codex build keeps Codex rollouts in its own home, so its sessions stay its own. */
export const platforms = {
  'codex': {
    store: { in: 'tool-home', home: 'codex', dir: 'sessions' },
    resume: (id) => `codex resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir) => new CodexAdapter('codex', storeDir),
    adapterAs: (platform, storeDir) => new CodexAdapter(platform, storeDir),
  },
  'codex-internal': {
    store: { in: 'tool-home', home: 'codex-internal', dir: 'sessions' },
    resume: (id) => `codex-internal --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir) => new CodexAdapter('codex-internal', storeDir),
    adapterAs: (platform, storeDir) => new CodexAdapter(platform, storeDir),
  },
  'tcodex': {
    store: { in: 'tool-home', home: 'tcodex', dir: 'sessions' },
    resume: (id) => `tcodex --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'edit_file', 'read_file', 'write_file']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir) => new CodexAdapter('tcodex', storeDir),
    adapterAs: (platform, storeDir) => new CodexAdapter(platform, storeDir),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
