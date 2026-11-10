import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { CopilotAdapter } from './session-adapter.js';

/** Copilot CLI keeps one append-only event log per session in its home; teamai reads them and writes none. */
export const platforms = {
  copilot: {
    // Copilot CLI stores one append-only events.jsonl under <Copilot home>/session-state/<id>/.
    store: { in: 'tool-home', home: 'copilot', dir: 'session-state' },
    resume: (id) => `copilot --resume ${id}`,
    thinking: false, images: false,
    nativeTools: new Set([
      'powershell', 'bash', 'view', 'edit', 'grep', 'glob', 'web_fetch', 'task',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    readOnly: true,
    adapter: (storeDir): AgentAdapter => new CopilotAdapter(storeDir),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
