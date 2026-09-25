import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getDataHome, type LocalConfig } from '../../types.js';

/**
 * Write `config` where its install keeps it, `<dataHome>/config.yaml`. A queue
 * write checks that file under the queue lock: a config the migration moved
 * away, or one init switched to another kind, saves nothing (#823 item 11).
 */
export function writeInstallConfig(config: LocalConfig): void {
  const file = path.join(getDataHome(config), 'config.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify({ repo: config.repo, username: config.username, scope: config.scope }));
}
