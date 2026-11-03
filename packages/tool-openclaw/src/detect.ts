import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectOpenclawVersion(): Promise<string> {
  const raw = await execVersion('openclaw');
  const match = raw.match(/^([\d.]+)/);

  return match?.[1] ?? '';
}

/** How teamai reads the version of OpenClaw. */
export const detect = { openclaw: detectOpenclawVersion } as const satisfies Record<string, VersionDetector>;
