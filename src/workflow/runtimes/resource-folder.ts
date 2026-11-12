import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRegularFileNoLink } from '@teamai/shared/regular-file';

// A resource kept as a folder that teamai runs or builds from, such as a runtime or a sandbox profile, is taken at its
// revision: what a person accepts, and what a record names, is every file the folder holds.

/**
 * What a resource folder holds, by relative path, sorted: its files, folders and links. A linked folder is not walked,
 * so nothing outside the folder is listed or read.
 */
export async function folderEntries(dir: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [''];

  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const entry of await fs.readdir(path.join(dir, folder), { withFileTypes: true })) {
      const relative = path.join(folder, entry.name);
      found.push(relative);

      if (entry.isDirectory()) pending.push(relative);
    }
  }

  return found.sort();
}

/** The first link a resource folder holds, by relative path, or none. */
export async function firstLink(dir: string): Promise<string | undefined> {
  for (const relative of await folderEntries(dir).catch(() => [])) {
    if ((await fs.lstat(path.join(dir, relative)).catch(() => undefined))?.isSymbolicLink() === true) return relative.split(path.sep).join('/');
  }

  return undefined;
}

/**
 * A resource folder's revision: a hash of every file under it, by relative path, executable bit and content, with a link
 * hashed as the path it names, never what it points to. Any change a teammate pushes there is a new revision.
 */
export async function folderRevision(dir: string): Promise<string> {
  const hash = createHash('sha256');

  for (const relative of await folderEntries(dir)) {
    const at = path.join(dir, relative);
    const stat = await fs.lstat(at);

    if (stat.isDirectory()) continue;
    const body = stat.isSymbolicLink() ? `link:${await fs.readlink(at)}` : await readRegularFileNoLink(at);
    hash.update(`${relative.split(path.sep).join('/')}\0${stat.mode & 0o111 ? 'x' : '-'}\0`).update(body).update('\0');
  }

  return hash.digest('hex');
}
