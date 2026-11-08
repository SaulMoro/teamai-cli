import type { ToolFamily } from '@teamai/tool-core/family';
import { family as claude } from '@teamai/tool-claude';
import { family as codex } from '@teamai/tool-codex';
import { family as qoder } from '@teamai/tool-qoder';
import { family as joycode } from '@teamai/tool-joycode';
import { family as pi } from '@teamai/tool-pi';
import { family as codebuddy } from '@teamai/tool-codebuddy';
import { family as kiro } from '@teamai/tool-kiro';
import { family as trae } from '@teamai/tool-trae';
import { family as zcode } from '@teamai/tool-zcode';
import { family as openclaw } from '@teamai/tool-openclaw';
import { family as hermes } from '@teamai/tool-hermes';
import { family as dsh } from '@teamai/tool-dsh';
import { family as muse } from '@teamai/tool-muse';
import { family as copilot } from '@teamai/tool-copilot';
import { family as opencode } from '@teamai/tool-opencode';
import { family as agy } from '@teamai/tool-agy';
import { family as cursor } from '@teamai/tool-cursor';

/** Every built-in tool family. The app reads tools only through these, never by importing a family. */
export const BUILT_IN_TOOLS = { claude, codex, qoder, joycode, pi, codebuddy, kiro, trae, zcode, openclaw, hermes, dsh, muse, copilot, opencode, agy, cursor } as const satisfies Readonly<Record<string, ToolFamily>>;

/** The sign-in variables of each built-in tool a step runtime launches on the member's own sign-in, by launch adapter id. */
// oxlint-disable-next-line teamai/tool-facts -- read from each launch adapter's own signIn, keyed by launch adapter id as LAUNCH_ADAPTERS is
export const SIGN_INS = { claude: claude.launch.claude.signIn, codex: codex.launch.codex.signIn, codebuddy: codebuddy.launch.codebuddy.signIn } as const;
