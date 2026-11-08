/**
 * Where macOS keeps `sandbox-exec` and `sw_vers`. They run from there by absolute path, never from PATH, where a planted
 * `sandbox-exec` (a repository's `node_modules/.bin`, `~/.local/bin`) would run the step unconfined. The runtime's test
 * bundle swaps this module for `testing/system-bin.ts`, which runs stand-ins.
 */
export const SYSTEM_BIN = '/usr/bin';
