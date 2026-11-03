import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';
import { launch } from './launch.js';

/** GitHub Copilot CLI. teamai keeps no Copilot sessions and reads no Copilot version; it reads Copilot tokens from the totals its session-end hook carries. */
export const family = { tools, launch, platforms: {}, tokens: {}, detect: {} } as const satisfies ToolFamily;
