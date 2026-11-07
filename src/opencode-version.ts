/**
 * The OpenCode version a member runs, which decides how teamai delivers to it and launches it. In a module of its own,
 * so a test mocks it where every caller reads it.
 */
import { probeBinary } from './utils/exec.js';

const majorVersions = new Map<string, Promise<number>>();

/**
 * OpenCode's major version, from `<binary> --version` (`opencode v2.0.24` on
 * V2, `1.18.35` on V1), asked once per binary per run. 1 when the binary is
 * absent or prints no version.
 */
export function opencodeMajorVersion(binary = 'opencode'): Promise<number> {
  let version = majorVersions.get(binary);

  if (!version) {
    version = probeBinary(binary).then((output) => {
      const match = /(\d+)\.\d+/.exec(output);

      return match ? Number(match[1]) : 1;
    });
    majorVersions.set(binary, version);
  }

  return version;
}
