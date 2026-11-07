import { execVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectClaudeVersion(): Promise<string> {
  const raw = await execVersion('claude');
  // "2.1.199 (Claude Code)" → "2.1.199"
  const match = raw.match(/^([\d.]+)/);

  return match?.[1] ?? raw;
}

/** How teamai reads the version of each Claude build it reads one of. */
export const detect = { claude: detectClaudeVersion } as const satisfies Record<string, VersionDetector>;
