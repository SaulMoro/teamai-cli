import type { ToolDescriptor } from './definition.js';
import type { VersionDetector } from './detect.js';
import type { LaunchAdapter } from './launch.js';
import type { SessionPlatformDefinition } from './sessions/platform.js';
import type { TokenFormat } from './tokens.js';

/**
 * One vendor's variants of one product, and everything only they use. Each tool's descriptor names its rows by id:
 * `launch` a launch profile here, `sessions` platforms here, `tokens` a token format here. A family lists every row
 * its tools name, a shared format of `tool-core/formats` included, and may hold a platform no tool lists
 * (the CodeBuddy IDE's store). Declare it `as const satisfies ToolFamily`, so its ids stay literal.
 */
export interface ToolFamily {
  readonly tools: Readonly<Record<string, ToolDescriptor>>;
  readonly launch: Readonly<Record<string, LaunchAdapter>>;
  readonly platforms: Readonly<Record<string, SessionPlatformDefinition>>;
  readonly tokens: Readonly<Record<string, TokenFormat>>;
  /** How teamai reads a tool's version, by tool id or platform id; a tool with none reads no version. */
  readonly detect: Readonly<Record<string, VersionDetector>>;
}
