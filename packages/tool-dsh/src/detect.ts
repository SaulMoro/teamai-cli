import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

// DeepSeek Harness: `dsh --version` prints e.g. "0.1.1" (optionally with a
// leading "v" or trailing commit info). Extract leading semver-ish digits.
async function detectDshVersion(): Promise<string> {
  const raw = await execVersion('dsh');
  const match = raw.match(/v?(\d+(?:\.\d+)*)/);

  return match?.[1] ?? '';
}

/** How teamai reads the version of dsh. */
export const detect = { dsh: detectDshVersion } as const satisfies Record<string, VersionDetector>;
