import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectMuseVersion(): Promise<string> {
  // "Muse Code 1.4.6 (1.4.6-R6000.1)" → "1.4.6"
  const raw = await execVersion('muse');

  return raw.match(/\d+\.\d+\.\d+/)?.[0] ?? '';
}

/** How teamai reads the version of Muse Code. */
export const detect = { muse: detectMuseVersion } as const satisfies Record<string, VersionDetector>;
