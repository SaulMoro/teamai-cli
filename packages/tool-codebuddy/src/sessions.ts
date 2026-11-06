import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { CodeBuddyAdapter } from './codebuddy-adapter.js';
import { CodeBuddyIdeAdapter } from './codebuddy-ide-adapter.js';
import { WorkBuddyAdapter } from './workbuddy-adapter.js';

/** CodeBuddy keeps the CLI's and the IDE's sessions in two stores, and WorkBuddy in its own. */
export const platforms = {
  'codebuddy': {
    // CodeBuddy 2.176.0 bundle: getHomeProjectsDir() is <CODEBUDDY_CONFIG_DIR or ~/.codebuddy>/projects.
    store: { in: 'tool-home', home: 'codebuddy', dir: 'projects' },
    resume: (id) => `codebuddy --resume ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (storeDir): AgentAdapter => new CodeBuddyAdapter(storeDir),
  },
  'codebuddy-ide': {
    tool: 'codebuddy-ide',
    store: { in: 'ide-history' },
    resume: (id) => `codebuddy-ide --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'write_to_file', 'edit_file', 'replace_in_file', 'delete_file',
      'bash', 'execute_command', 'grep', 'search_content', 'glob', 'list_dir', 'codebase_search',
      'web_search', 'web_fetch', 'preview_url', 'lsp', 'task', 'todo_write', 'use_skill',
      'update_memory', 'image_gen',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    adapter: (): AgentAdapter => new CodeBuddyIdeAdapter(),
  },
  'workbuddy': {
    store: { in: 'tool-home', home: 'workbuddy', dir: 'projects' },
    resume: (id) => `workbuddy --resume ${id}`,
    thinking: true, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'task', 'todo_write',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: true,
    idFormat: 'uuid',
    adapter: (storeDir): AgentAdapter => new WorkBuddyAdapter(storeDir),
  },
} as const satisfies Record<string, SessionPlatformDefinition>;
