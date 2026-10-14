import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A stand-in `opencode` (V2) for the session commands teamai runs: `--version`,
 * `session list --format json`, `session export <id>` and `session delete <id>`.
 * Sessions are export files (`{ info, messages }`, the shape `session export`
 * prints) under `$XDG_DATA_HOME/fake-opencode/sessions/<id>.json`, so a test
 * plants one by writing its export. `list` shows the sessions whose
 * `info.location.directory` is the directory it runs in, newest first.
 *
 * Like the real CLI under an isolated data home, any session command without
 * `--standalone` fails: it would try to start the managed background service.
 * `$XDG_DATA_HOME/fake-opencode/version` overrides the version it prints.
 */
const CLI = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(process.env.XDG_DATA_HOME || '', 'fake-opencode');
const dir = path.join(root, 'sessions');
const args = process.argv.slice(2);
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1); };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
if (args[0] === '--version') {
  let version = 'opencode v2.0.29';
  try { version = fs.readFileSync(path.join(root, 'version'), 'utf8').trim(); } catch {}
  process.stdout.write(version + '\n');
  process.exit(0);
}
if (args[0] !== 'session') fail('fake opencode: unsupported command ' + args.join(' '));
if (!args.includes('--standalone')) fail('Managed service port 49374 on 127.0.0.1 is already in use by another process.');
const positional = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && ['--format', '-n', '--max-count'].includes(args[i - 1])));
const [, sub, id] = positional;
const file = (sid) => path.join(dir, sid + '.json');
if (sub === 'list') {
  const cwd = real(process.cwd());
  const rows = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).info; } catch { continue; }
    if (real(info.location.directory) !== cwd) continue;
    rows.push({ id: info.id, title: info.title, updated: info.time.updated, created: info.time.created, projectId: info.projectID, directory: info.location.directory });
  }
  rows.sort((a, b) => b.updated - a.updated);
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
} else if (sub === 'export') {
  if (!id.startsWith('ses')) fail('Expected a string starting with "ses"');
  if (!fs.existsSync(file(id))) fail('Session not found: ' + id);
  process.stdout.write(fs.readFileSync(file(id), 'utf8'));
} else if (sub === 'delete') {
  if (!fs.existsSync(file(id))) fail('Session not found: ' + id);
  fs.rmSync(file(id));
} else fail('fake opencode: unsupported command ' + args.join(' '));
`;

/** Write the fake `opencode` into a new directory and return it (put it on PATH). */
export function installFakeOpencode(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-opencode-')));
  const script = path.join(dir, 'fake-opencode.cjs');
  fs.writeFileSync(script, CLI);
  const node = JSON.stringify(process.execPath);
  fs.writeFileSync(path.join(dir, 'opencode'), `#!/bin/sh\nexec ${node} ${JSON.stringify(script)} "$@"\n`);
  fs.chmodSync(path.join(dir, 'opencode'), 0o755);
  fs.writeFileSync(path.join(dir, 'opencode.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  return dir;
}

/** The export a real OpenCode 2.0.29 printed for a session that read a file, ran `ls`, and got an image. */
export function opencodeExportFixture(): OpencodeExport {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode', 'export-tool-calls.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OpencodeExport;
}

export type OpencodeExport = {
  info: { id: string; title: string; time: { created: number; updated: number }; location: { directory: string } } & Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
};

/** Plant a session the fake lists and exports. `raw` replaces the export file's content. */
export function plantOpencodeSession(dataHome: string, session: OpencodeExport, raw?: string): void {
  const dir = path.join(dataHome, 'fake-opencode', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.info.id}.json`), raw ?? JSON.stringify(session, null, 2));
}

/** Make the fake print `version` for `opencode --version`. */
export function setFakeOpencodeVersion(dataHome: string, version: string): void {
  fs.mkdirSync(path.join(dataHome, 'fake-opencode'), { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'fake-opencode', 'version'), version);
}
