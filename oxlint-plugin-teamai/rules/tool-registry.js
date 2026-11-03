import path from 'node:path';
import { defineRule } from '@oxlint/plugins';

import { importVisitors } from '../imports.js';
import { lintedPath, scopedFiles, sourcePath } from '../utils.js';

/** The raw tool tables, by the module that defines each. */
const TABLES = new Map([
  ['src/tools.ts', 'TOOLS'],
  ['src/tool-launch/adapters.ts', 'LAUNCH_ADAPTERS'],
  ['src/session-flow/adapters/index.ts', 'ADAPTER_REGISTRY'],
]);

const [REGISTRY] = scopedFiles(['src/tool-registry.ts', ...TABLES.keys()]);

/**
 * Readers that still import a raw table. A new reader goes through the registry instead; this list only shrinks,
 * and an entry that no longer reads a table fails until it is removed.
 */
const NOT_YET_MOVED = new Set([
  'scripts/doc-checks/readme-matrix.ts',
  'scripts/tool-support.ts',
  'src/autocompact-reconcile.ts',
  'src/bundled-runtime.ts',
  'src/dashboard-collector.ts',
  'src/hooks.ts',
  'src/init.ts',
  'src/instruction-targets.ts',
  'src/known-agents.ts',
  'src/locate.ts',
  'src/mcp-reconcile.ts',
  'src/resources/agents.ts',
  'src/scorers/judge.ts',
  'src/session-flow/agent-session.ts',
  'src/session-flow/index.ts',
  'src/skill-use.ts',
  'src/source.ts',
  'src/tool-home-record.ts',
  'src/tool-home.ts',
  'src/tool-launch/tools.ts',
  'src/uninstall.ts',
  'src/utils/tool-call.ts',
  'src/utils/tool-names.ts',
  'src/workflow/discovery/render.ts',
  'src/workflow/drivers/skill/preflight.ts',
  'src/workflow/drivers/skill/skill-driver.ts',
  'src/workflow/place/clone.ts',
]);

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Read the tool tables only through the tool registry.' },
  },
  create(context) {
    const file = lintedPath(context);
    const from = sourcePath(context);

    if (!/^(src|scripts)\//.test(from) || from.startsWith('src/__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(from)) return {};

    if (from === REGISTRY || TABLES.has(from)) return {};
    const root = file.slice(0, file.length - from.length);
    let reads = false;

    return {
      ...importVisitors(({ node, specifier, names }) => {
        if (!specifier.startsWith('.')) return;
        const owner = `${path.posix.relative(root, path.posix.resolve(path.posix.dirname(file), specifier)).replace(/\.[cm]?js$/, '')}.ts`;
        const table = TABLES.get(owner);

        if (table === undefined || !names.some((name) => name === table || name === '*')) return;
        reads = true;

        if (!NOT_YET_MOVED.has(from)) {
          context.report({ node, message: `Read tools through src/tool-registry.ts, not ${table} from ${owner}, so every reader sees the same tools: a tool the registry adds reaches this one too.` });
        }
      }),
      'Program:exit'(node) {
        if (NOT_YET_MOVED.has(from) && !reads) {
          context.report({ node, message: `${from} no longer reads a raw tool table: remove it from NOT_YET_MOVED in oxlint-plugin-teamai/rules/tool-registry.js.` });
        }
      },
    };
  },
});
