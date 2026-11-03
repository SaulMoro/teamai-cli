import type { ToolFamily } from '@teamai/tool-core/family';
import { family as claude } from '@teamai/tool-claude';

/** Every built-in tool family. The app reads tools only through these, never by importing a family. */
export const BUILT_IN_TOOLS = { claude } as const satisfies Readonly<Record<string, ToolFamily>>;
