import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import type { SessionPlatformDefinition, StoredPlatformDefinition } from '@teamai/tool-core/sessions/platform';

/** A Claude build's platform: Claude Code transcripts in the home of its own `command`, which resumes them. */
function claudeBuild<const Command extends string>(platform: string, command: Command) {
  return {
    store: { in: 'tool-home', home: command, dir: 'projects' },
    resume: (id: string) => `${command} --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir: string) => new ClaudeCodeAdapter(platform, storeDir),
    adapterAs: (as: string, storeDir: string) => new ClaudeCodeAdapter(as, storeDir),
  } as const satisfies StoredPlatformDefinition<Command>;
}

/** Each Claude build keeps Claude Code transcripts in its own home, so its sessions stay its own. */
export const platforms = {
  'claude-code': claudeBuild('claude-code', 'claude'),
  'claude-internal': claudeBuild('claude-internal', 'claude-internal'),
  'tclaude': claudeBuild('tclaude', 'tclaude'),
} as const satisfies Record<string, SessionPlatformDefinition>;
