import type { ToolFamily } from '@teamai/tool-core/family';
import { family as claude } from '@teamai/tool-claude';
import { family as codex } from '@teamai/tool-codex';

/** Every built-in tool family. The app reads tools only through these, never by importing a family. */
export const BUILT_IN_TOOLS = { claude, codex } as const satisfies Readonly<Record<string, ToolFamily>>;
