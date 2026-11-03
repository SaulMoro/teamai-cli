import { execVersion, readPlistVersion, type VersionDetector } from '@teamai/tool-core/detect';

async function detectCodebuddyCliVersion(): Promise<string> {
  return execVersion('codebuddy');
}

/** The version in the first of `apps` installed, read from its bundle's Info.plist. */
async function firstAppVersion(apps: readonly string[]): Promise<string> {
  for (const appPath of apps) {
    const ver = await readPlistVersion(appPath);

    if (ver) return ver;
  }

  return '';
}

/** How teamai reads the version of the CodeBuddy CLI, the CodeBuddy IDE and WorkBuddy. */
export const detect = {
  codebuddy: detectCodebuddyCliVersion,
  'codebuddy-ide': () => firstAppVersion(['/Applications/CodeBuddy.app', '/Applications/CodeBuddy CN.app']),
  workbuddy: () => firstAppVersion(['/Applications/WorkBuddy.app']),
} as const satisfies Record<string, VersionDetector>;
