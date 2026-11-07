import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { probeBinary } from './exec.js';

/** Reads the version of a tool installed here, or '' when it reads none. */
export type VersionDetector = () => Promise<string>;

// Launch through cross-spawn (probeBinary): on Windows npm installs these CLIs
// as `<name>.cmd` shims, which the native execFile cannot find or start.
export async function execVersion(bin: string, args: string[] = ['--version']): Promise<string> {
  return probeBinary(bin, args);
}

/** The version in a macOS app bundle's Info.plist, or '' when it has none. */
export async function readPlistVersion(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');

  try {
    const content = await readFile(plistPath, 'utf-8');

    const match = content.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );

    return match?.[1] ?? '';
  } catch {
    return '';
  }
}
