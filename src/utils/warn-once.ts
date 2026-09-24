import { log } from './logger.js';

/**
 * Warnings already shown in this run. A pull resolves the manifests and each
 * entry type several times (per scope, and again for hooks, MCP and models
 * after the scopes), so a warning about the team repo would otherwise repeat.
 */
const shown = new Set<string>();

/** Warn once per run; returns false when `message` was already shown. */
export function warnOnce(message: string): boolean {
  if (shown.has(message)) return false;
  shown.add(message);
  log.warn(message);
  return true;
}

/** Start a run: `pull` calls this so each pull warns again, once. */
export function resetWarnOnce(): void {
  shown.clear();
}
