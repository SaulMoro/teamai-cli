import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectAgyVersion(): Promise<string> {
  // Antigravity CLI: "1.4.10"
  const raw = await execVersion('agy');

  return raw.match(/\d+\.\d+\.\d+/)?.[0] ?? '';
}

/** How teamai reads the version of agy. */
export const detect = { agy: detectAgyVersion } as const satisfies Record<string, VersionDetector>;
