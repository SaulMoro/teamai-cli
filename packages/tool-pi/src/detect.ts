import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectPiVersion(): Promise<string> {
  // Pi Coding Agent: "1.4.0"
  const raw = await execVersion('pi');

  return raw.match(/\d+\.\d+\.\d+/)?.[0] ?? '';
}

/** How teamai reads the version of pi; it reads none of omp. */
export const detect = { pi: detectPiVersion } as const satisfies Record<string, VersionDetector>;
