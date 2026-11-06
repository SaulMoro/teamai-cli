import fs from 'node:fs';
import { setSilent } from '../src/utils/logger.js';
import { loadCommandTable } from './command-table.js';
import path from 'node:path';
import { TOOL_SUPPORT_PAGES, renderToolSupportPage } from './tool-support.js';
import { COMMANDS_REFERENCE_PATH, renderCommandsReference } from './commands-reference.js';
import { TOOL_ORDER } from '../src/tool-registry.js';

const root = process.cwd();
const args = process.argv.slice(2);

if (args.some((arg) => arg !== '--write')) throw new Error('Usage: node scripts/check-docs.mjs [--write]');

const write = args.includes('--write');
const program = await loadCommandTable();

const generated = [
  { file: COMMANDS_REFERENCE_PATH, content: renderCommandsReference(program) },
  { file: TOOL_SUPPORT_PAGES.en, content: renderToolSupportPage('en') },
  { file: TOOL_SUPPORT_PAGES['zh-CN'], content: renderToolSupportPage('zh-CN') },
  // The shipped tool ids, which teamai/tool-facts reads: the lint plugin is plain JavaScript and cannot import the registry.
  { file: 'oxlint-plugin-teamai/tool-ids.generated.json', content: `${JSON.stringify(TOOL_ORDER, null, 2)}\n` },
];

for (const output of generated) {
  const file = path.join(root, output.file);

  if (write) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, output.content);
  }
  else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output.content) {
    console.error(`Generated documentation is stale: ${output.file}. Run node scripts/check-docs.mjs --write.`);
    process.exitCode = 1;
  }
}

setSilent(true);

await import('./doc-checks/readme-matrix.js');

await import('./doc-checks/skill-commands-exist.js');

await import('./doc-checks/team-wiki-codebase-skill.js');

await import('./doc-checks/skill-content.js');

await import('./doc-checks/workflow-docs-examples.js');

if (!process.exitCode) console.log('Documentation checks passed.');
