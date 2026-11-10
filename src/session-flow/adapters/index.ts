/**
 * adapters/index.ts — Adapter registration.
 *
 * Register every platform adapter in ADAPTER_REGISTRY for the migration engine.
 */

import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import type { LocalConfig } from '../../types.js';
import path from 'node:path';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { StoredPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { isStoredSessionPlatform, SESSION_PLATFORM_FACTS, type SessionPlatform } from './platform-facts.js';
import { sessionStoreDir } from '../../locate.js';
import { instanceHomeDir } from '../../tool-instances.js';
import { instanceNames, instancePlatform } from '../../tool-registry.js';

/** Builds a platform's adapter on its store, which follows the member's recorded `toolRoots` (`sessionStoreDir`). */
export type AdapterFactory = (toolRoots?: LocalConfig['toolRoots']) => AgentAdapter;

/** Platform id → adapter factory. Open to any id so a test can register a stand-in platform. */
export interface AdapterRegistry {
  [platform: string]: AdapterFactory;
}

export const ADAPTER_REGISTRY: AdapterRegistry = {
  // Base platforms
  'claude-code': (toolRoots) => BUILT_IN_TOOLS.claude.platforms['claude-code'].adapter(sessionStoreDir('claude-code', toolRoots)),
  codex: (toolRoots) => BUILT_IN_TOOLS.codex.platforms.codex.adapter(sessionStoreDir('codex', toolRoots)),
  qoder: (toolRoots) => BUILT_IN_TOOLS.qoder.platforms.qoder.adapter(sessionStoreDir('qoder', toolRoots)),
  'qoder-cn': (toolRoots) => BUILT_IN_TOOLS.qoder.platforms['qoder-cn'].adapter(sessionStoreDir('qoder-cn', toolRoots)),
  // CodeBuddy has two independent stores, split into two platforms:
  //   codebuddy     = CLI (<CodeBuddy home>/projects/...)
  //   codebuddy-ide = IDE GUI (CodeBuddyExtension/.../history)
  codebuddy: (toolRoots) => BUILT_IN_TOOLS.codebuddy.platforms.codebuddy.adapter(sessionStoreDir('codebuddy', toolRoots)),
  'codebuddy-ide': () => BUILT_IN_TOOLS.codebuddy.platforms['codebuddy-ide'].adapter(),
  workbuddy: (toolRoots) => BUILT_IN_TOOLS.codebuddy.platforms.workbuddy.adapter(sessionStoreDir('workbuddy', toolRoots)),
  cursor: (toolRoots) => BUILT_IN_TOOLS.cursor.platforms.cursor.adapter(sessionStoreDir('cursor', toolRoots)),
  opencode: (toolRoots) => BUILT_IN_TOOLS.opencode.platforms.opencode.adapter(sessionStoreDir('opencode', toolRoots)),
  agy: (toolRoots) => BUILT_IN_TOOLS.agy.platforms.agy.adapter(sessionStoreDir('agy', toolRoots)),
  pi: (toolRoots) => BUILT_IN_TOOLS.pi.platforms.pi.adapter(sessionStoreDir('pi', toolRoots)),
  omp: (toolRoots) => BUILT_IN_TOOLS.pi.platforms.omp.adapter(sessionStoreDir('omp', toolRoots)),
  muse: (toolRoots) => BUILT_IN_TOOLS.muse.platforms.muse.adapter(sessionStoreDir('muse', toolRoots)),
  hermes: (toolRoots) => BUILT_IN_TOOLS.hermes.platforms.hermes.adapter(sessionStoreDir('hermes', toolRoots)),
  copilot: (toolRoots) => BUILT_IN_TOOLS.copilot.platforms.copilot.adapter(sessionStoreDir('copilot', toolRoots)),
  // TeamAI variants (different path prefixes, identical format)
  'claude-internal': (toolRoots) => BUILT_IN_TOOLS.claude.platforms['claude-internal'].adapter(sessionStoreDir('claude-internal', toolRoots)),
  tclaude: (toolRoots) => BUILT_IN_TOOLS.claude.platforms.tclaude.adapter(sessionStoreDir('tclaude', toolRoots)),
  'codex-internal': (toolRoots) => BUILT_IN_TOOLS.codex.platforms['codex-internal'].adapter(sessionStoreDir('codex-internal', toolRoots)),
  tcodex: (toolRoots) => BUILT_IN_TOOLS.codex.platforms.tcodex.adapter(sessionStoreDir('tcodex', toolRoots)),
  joycode: (toolRoots) => BUILT_IN_TOOLS.joycode.platforms.joycode.adapter(sessionStoreDir('joycode', toolRoots)),
} satisfies Record<SessionPlatform, AdapterFactory>;

/**
 * The factory of an instance's own platform: the adapter of the shipped platform whose format its sessions keep, under
 * the instance's id, on that platform's store in the instance's home.
 */
function instanceFactory(platform: string): AdapterFactory | undefined {
  const hosted = instancePlatform(platform);

  if (!hosted || !isStoredSessionPlatform(hosted.platform)) return undefined;
  const shipped = hosted.platform;
  const definition: StoredPlatformDefinition = SESSION_PLATFORM_FACTS[shipped];

  const { home } = hosted.instance;

  if (definition.store.in !== 'tool-home' || definition.adapterAs === undefined || home === undefined) return undefined;
  const { store, adapterAs } = definition;

  return () => adapterAs(platform, path.join(instanceHomeDir(home), store.dir));
}

/** The factory of `platform`: a shipped platform's, or an instance's own. */
function factoryOf(platform: string): AdapterFactory | undefined {
  return Object.hasOwn(ADAPTER_REGISTRY, platform) ? ADAPTER_REGISTRY[platform] : instanceFactory(platform);
}

/** The platforms of the instances this process knows that keep sessions of their own: each one's name. */
function instancePlatforms(): string[] {
  return instanceNames().filter((name) => instancePlatform(name) !== undefined);
}

export function getAdapter(platform: string, toolRoots?: LocalConfig['toolRoots']): AgentAdapter {
  const factory = factoryOf(platform);

  if (!factory) {
    throw new Error(`Unsupported platform: ${platform}. Registered: ${listAvailablePlatforms().join(', ')}`);
  }

  return factory(toolRoots);
}

export function listAvailablePlatforms(): string[] {
  return [...Object.keys(ADAPTER_REGISTRY), ...instancePlatforms()];
}

export function listInstalledPlatforms(toolRoots?: LocalConfig['toolRoots'], projectPath = process.cwd()): string[] {
  const installed: string[] = [];

  for (const platform of listAvailablePlatforms()) {
    const factory = factoryOf(platform);

    if (!factory) continue;

    try {
      const adapter = factory(toolRoots);

      if (adapter.isReady(projectPath)) installed.push(platform);
    } catch {
      // skip
    }
  }

  return installed;
}

export { AgentAdapter, type SessionMeta } from '@teamai/tool-core/sessions/base';

export { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';

export { CodexAdapter } from '@teamai/tool-core/formats/codex';

