import type { ToolId } from './types.js';

export type Evidence = 'verified' | 'source' | 'docs' | 'assumed';

/** The host's dedicated skill tool, by its raw name. */
export type SkillCall = { readonly name: string; readonly evidence: Evidence };

export type SkillLoad =
  | { readonly calls: readonly SkillCall[]; readonly mention?: '$' | '/skill:' }
  | 'unknown';

export type ToolDescriptor = { readonly home: { readonly dir: string }; readonly skillLoad: SkillLoad };

/**
 * What teamai knows about each built-in tool. `home.dir` is relative to `$HOME`.
 *
 * `calls` lists only a dedicated skill tool; a read of a SKILL.md path is not
 * one. `mention` is a prompt prefix that loads a skill with no tool call.
 * `'unknown'` records nothing. Evidence per call:
 * - verified: a recorded run of the tool, or its own loader run on teamai's output
 * - source: the tool's source or shipped bundle
 * - docs: the tool's documentation
 * - assumed: teamai's own code or the issue matrix only
 */
export const TOOLS = {
  claude: { home: { dir: '.claude' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'verified' }] } },
  codex: { home: { dir: '.codex' }, skillLoad: { calls: [], mention: '$' } },
  'codex-internal': { home: { dir: '.codex-internal' }, skillLoad: { calls: [], mention: '$' } },
  'claude-internal': { home: { dir: '.claude-internal' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] } },
  tclaude: { home: { dir: '.tclaude' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] } },
  tcodex: { home: { dir: '.tcodex' }, skillLoad: { calls: [], mention: '$' } },
  cursor: { home: { dir: '.cursor' }, skillLoad: { calls: [] } },
  copilot: { home: { dir: '.copilot' }, skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] } },
  joycode: { home: { dir: '.joycode' }, skillLoad: 'unknown' },
  qoder: { home: { dir: '.qoder' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] } },
  'qoder-cn': { home: { dir: '.qoder-cn' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] } },
  kiro: { home: { dir: '.kiro' }, skillLoad: 'unknown' },
  trae: { home: { dir: '.trae' }, skillLoad: 'unknown' },
  'trae-cn': { home: { dir: '.trae-cn' }, skillLoad: 'unknown' },
  zcode: { home: { dir: '.zcode' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] } },
  omp: { home: { dir: '.omp' }, skillLoad: { calls: [] } },
  pi: { home: { dir: '.pi' }, skillLoad: { calls: [], mention: '/skill:' } },
  // The CodeBuddy IDE sends `skill` (src/utils/tool-names.ts).
  codebuddy: { home: { dir: '.codebuddy' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'verified' }, { name: 'skill', evidence: 'assumed' }] } },
  // Hermes (`skill_view`) and OpenClaw (`skills_read`) have skill tools, but teamai installs no post-tool-use hook for them yet.
  openclaw: { home: { dir: '.openclaw' }, skillLoad: 'unknown' },
  hermes: { home: { dir: '.hermes' }, skillLoad: 'unknown' },
  dsh: { home: { dir: '.dsh' }, skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] } },
  workbuddy: { home: { dir: '.workbuddy' }, skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }, { name: 'skill', evidence: 'assumed' }] } },
  opencode: { home: { dir: '.config/opencode' }, skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] } },
  muse: { home: { dir: '.config/muse' }, skillLoad: { calls: [{ name: 'read_skill', evidence: 'verified' }] } },
} as const satisfies Record<ToolId, ToolDescriptor>;

export function isToolId(value: string): value is ToolId {
  return Object.hasOwn(TOOLS, value);
}
