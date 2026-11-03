import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectCursorVersion(): Promise<string> {
  // cursor --version outputs multiple lines; version is on the first line
  const raw = await execVersion('cursor');

  return raw.split('\n')[0]?.trim() ?? '';
}

/** How teamai reads the version of Cursor. */
export const detect = { cursor: detectCursorVersion } as const satisfies Record<string, VersionDetector>;
