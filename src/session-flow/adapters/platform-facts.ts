import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import type { ToolId } from '../../tools.js';

// oxlint-disable-next-line teamai/tool-facts -- keyed by session platform, which this table defines; a tool lists its own in TOOLS.sessions
export const SESSION_PLATFORM_FACTS = {
  'claude-code': BUILT_IN_TOOLS.claude.platforms['claude-code'],
  'claude-internal': BUILT_IN_TOOLS.claude.platforms['claude-internal'],
  tclaude: BUILT_IN_TOOLS.claude.platforms.tclaude,
  codex: BUILT_IN_TOOLS.codex.platforms.codex,
  'codex-internal': BUILT_IN_TOOLS.codex.platforms['codex-internal'],
  tcodex: BUILT_IN_TOOLS.codex.platforms.tcodex,
  qoder: BUILT_IN_TOOLS.qoder.platforms.qoder,
  'qoder-cn': BUILT_IN_TOOLS.qoder.platforms['qoder-cn'],
  joycode: BUILT_IN_TOOLS.joycode.platforms.joycode,
  codebuddy: BUILT_IN_TOOLS.codebuddy.platforms.codebuddy,
  'codebuddy-ide': BUILT_IN_TOOLS.codebuddy.platforms['codebuddy-ide'],
  workbuddy: BUILT_IN_TOOLS.codebuddy.platforms.workbuddy,
  'cursor': {
    // The Cursor CLI's transcripts move with CURSOR_DATA_DIR, recorded under its own root (RELOCATABLE_TOOLS).
    store: { in: 'tool-home', home: 'cursor', dir: 'projects', root: 'cursor-data' },
    resume: (id) => `cursor --resume ${id}`,
    thinking: false, images: false,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'delete_file',
      'web_fetch', 'web_search', 'semantic_search',
    ]),
    legacyIdWithoutWorkspace: false,
    sqliteRegistrationOnWindows: true,
    idFormat: 'uuid',
  },
  opencode: BUILT_IN_TOOLS.opencode.platforms.opencode,
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
  },
  pi: BUILT_IN_TOOLS.pi.platforms.pi,
  omp: BUILT_IN_TOOLS.pi.platforms.omp,
  muse: BUILT_IN_TOOLS.muse.platforms.muse,
  hermes: BUILT_IN_TOOLS.hermes.platforms.hermes,
} satisfies Record<string, SessionPlatformFacts<ToolId>>;

/** A platform teamai has a session adapter for. */
export type SessionPlatform = keyof typeof SESSION_PLATFORM_FACTS;

/** A platform whose store `sessionStoreDir` resolves: every one but a store its adapter finds itself. */
export type StoredSessionPlatform = {
  [P in SessionPlatform]: (typeof SESSION_PLATFORM_FACTS)[P]['store'] extends { readonly in: 'ide-history' } ? never : P
}[SessionPlatform];

export function isSessionPlatform(platform: string): platform is SessionPlatform {
  return Object.hasOwn(SESSION_PLATFORM_FACTS, platform);
}

export function sessionPlatformFacts(platform: string): SessionPlatformFacts | undefined {
  return isSessionPlatform(platform) ? SESSION_PLATFORM_FACTS[platform] : undefined;
}

/** The command that continues a restored session in its platform's CLI. */
export function resumeCommand(platform: SessionPlatform, sessionId: string): string {
  const facts: SessionPlatformFacts = SESSION_PLATFORM_FACTS[platform];

  return facts.resume(sessionId);
}
