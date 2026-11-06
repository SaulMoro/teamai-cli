import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectHermesVersion(): Promise<string> {
  const raw = await execVersion('hermes');
  // hermes --version may output "(2026.8.7)\nProject: ..." — extract from parens or leading digits.
  const match = raw.match(/^\(?(\d+(?:\.\d+)*)\)?/);

  return match?.[1] ?? '';
}

/** How teamai reads the version of Hermes. */
export const detect = { hermes: detectHermesVersion } as const satisfies Record<string, VersionDetector>;
