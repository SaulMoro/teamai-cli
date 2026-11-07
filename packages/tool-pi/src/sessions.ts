import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { PiAdapter } from './session-adapter.js';

/** pi and omp keep their sessions in their own homes; teamai reads them and writes none. */
export const platforms = {
  'pi': {
    // Pi 1.4.0: PI_CODING_AGENT_SESSION_DIR or settings.sessionDir, else <PI_CODING_AGENT_DIR or ~/.pi/agent>/sessions.
    store: { in: 'tool-home', home: 'pi', dir: 'sessions' },
    resume: (id) => `pi --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'web_search', 'web_fetch', 'task']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    adapter: (storeDir): AgentAdapter => new PiAdapter('pi', storeDir, !process.env.PI_CODING_AGENT_SESSION_DIR),
  },
  'omp': {
    // OMP 18.12.6: <resolved profile agent root>/sessions/<cwd>/<timestamp>_<id>.jsonl.
    store: { in: 'tool-home', home: 'omp', dir: 'sessions' },
    resume: (id) => `omp --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set(['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'web_search', 'web_fetch', 'task']),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    adapter: (storeDir): AgentAdapter => new PiAdapter('omp', storeDir),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
