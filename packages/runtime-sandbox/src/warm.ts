import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import { readRegularFileSync } from '@teamai/shared/regular-file';
import type { ProfileOption, WarmOptions } from './options.js';
import type { Ran } from './providers/cli.js';

// ─── The warm image ──────────────────────────────────────
//
//  An optional image (sbx: a saved template) with the toolchain and the package manager's store already filled, which
//  a provider starts each attempt from instead of its base. It is made at the first open for its key, in a scratch
//  sandbox with the network and no credential, where only copies of the `cache` files are, in a scratch directory
//  outside the checkout:
//
//    key        sha256(base, recipe, a profile folder's revision, each cache file's path and bytes), its first 16 hex digits
//    tag        teamai-warm:<key>
//    prepare    the provider runs `prepare` in /bin/sh, in that directory, then saves the sandbox as the tag
//    containerfile   docker and podman build it with that directory as the whole context
//
//  The directory is a bind mount, which a saved image never holds, and is removed once the image is saved, so the image
//  holds no file of the checkout. Opens of one key in this process wait on one build; another process that finds the tag
//  saved reuses it.
//

/** The repository part of every warm image's tag: `teamai-warm:<key>`. */
export const WARM_REPOSITORY = 'teamai-warm';

/**
 * Who makes a warm image here: this machine and process. A scratch sandbox carries it, and a scratch directory this
 * process's pid, so a sweep removes what a build left whose process no longer runs, and never one that still runs.
 */
export const WARM_BY = `${os.hostname()}:${process.pid}`;

/** Whether `pid` names a process that runs, or one this process may not signal; a pid it cannot read is taken as running. */
export function isRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Whether `by`, what a scratch sandbox's WARM_BY says, names a process of this machine that no longer runs. */
export function isLeftBehind(by: string): boolean {
  const at = by.lastIndexOf(':');

  return at > 0 && by.slice(0, at) === os.hostname() && !isRunning(Number(by.slice(at + 1)));
}

/**
 * Removes the scratch directories warm builds of this user left whose process no longer runs (a runtime killed while it
 * built). Another user's, in a temporary directory they share, stays theirs.
 */
export function removeLeftScratch(): void {
  const uid = process.getuid?.();

  for (const name of fs.readdirSync(os.tmpdir())) {
    const pid = /^teamai-warm-(\d+)-/.exec(name)?.[1];
    const dir = path.join(os.tmpdir(), name);

    if (pid !== undefined && !isRunning(Number(pid)) && (uid === undefined || fs.statSync(dir, { throwIfNoEntry: false })?.uid === uid)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The most of a failed build's or prepare's output its failure quotes. */
const TAIL = 600;

/** A warm image to have: its tag, its key, the `cache` files it is made with, and how: a command, or a containerfile's path. */
export interface WarmPlan {
  tag: string;
  key: string;
  /** Each `cache` file: its path relative to the checkout, and where its bytes are on this machine, inside the checkout. */
  cache: ReadonlyArray<{ file: string; from: string }>;
  make: { prepare: string } | { containerfile: string };
}

/** The end of `output`, at most TAIL characters of it, for a failure. */
function tailOf(output: string): string {
  const trimmed = output.trim();

  return trimmed.length > TAIL ? `…${trimmed.slice(-TAIL)}` : trimmed;
}

/** `sandbox_failed` for a step of making a warm image, `what` happened, that `ran` failed: with its code and output, or why it did not run. */
export function warmFailed(what: string, ran: Ran) {
  const how = ran.kind === 'ran' ? `, exiting with code ${ran.code}. It printed: ${tailOf(`${ran.stdout}\n${ran.stderr}`) || 'nothing'}` : `: ${ran.message}`;

  return { ok: false as const, failure: { code: 'sandbox_failed', message: `${what}${how}. No step ran; fix warm, and start again.` } satisfies RuntimeFailure };
}

/**
 * The Containerfile `file` of the folder of sandbox profile `profile`: a file the folder itself holds, never a link or a
 * path out of it, since the folder's revision is all a person reviewed of it.
 */
function inFolder(file: string, profile: ProfileOption & { folder: string }): { ok: true; from: string } | { ok: false; failure: RuntimeFailure } {
  const refuse = (message: string) => ({ ok: false as const, failure: { code: 'bad_option', key: 'warm.containerfile', message } satisfies RuntimeFailure });
  const inside = path.relative(profile.folder, path.resolve(profile.folder, file));

  if (path.isAbsolute(file) || inside === '' || inside === '..' || inside.startsWith(`..${path.sep}`)) return refuse(`${file} is not a path inside the folder of sandbox profile "${profile.name}". Give it relative to the folder, for example ./Containerfile`);
  const from = path.join(profile.folder, inside);
  const stat = fs.lstatSync(from, { throwIfNoEntry: false });

  if (stat?.isSymbolicLink() === true) return refuse(`${file} is a link, and a sandbox profile builds only from the files its folder holds. Replace it with the file itself`);

  return stat?.isFile() === true ? { ok: true, from } : refuse(`${file} is not a file in the folder of sandbox profile "${profile.name}"`);
}

/**
 * The warm image for `base` and `recipe` with the `cache` files of `checkout`, or `bad_option` on `warm.<key>` naming a
 * file that is not in the checkout. A recipe of a profile folder takes its Containerfile from the folder, and its key
 * holds the folder's revision, so any change pushed to the folder makes a new image.
 */
export function planWarm({ base, recipe, checkout, profile }: { base: string; recipe: WarmOptions; checkout: string; profile?: ProfileOption }): { ok: true; plan: WarmPlan } | { ok: false; failure: RuntimeFailure } {
  const folder = profile?.folder === undefined ? undefined : { ...profile, folder: profile.folder };
  const hash = crypto.createHash('sha256').update(JSON.stringify({ base, recipe, ...(folder && { revision: folder.revision }) }));
  const ownFile = recipe.containerfile !== undefined && folder !== undefined ? inFolder(recipe.containerfile, folder) : undefined;

  if (ownFile?.ok === false) return ownFile;
  const files = [...recipe.cache.map((file) => ({ file, key: 'warm.cache' })), ...(recipe.containerfile === undefined || ownFile !== undefined ? [] : [{ file: recipe.containerfile, key: 'warm.containerfile' }])];
  const real = fs.realpathSync(checkout);
  const read: Array<{ file: string; from: string }> = [];

  for (const { file, key } of files) {
    const inside = path.relative(checkout, path.resolve(checkout, file));

    if (path.isAbsolute(file) || inside === '..' || inside.startsWith(`..${path.sep}`) || inside === '') {
      return { ok: false, failure: { code: 'bad_option', key, message: `${file} is not a path inside the checkout. Give it relative to the checkout, for example package-lock.json` } };
    }

    let from: string;
    let bytes: Buffer;

    try {
      from = fs.realpathSync(path.join(real, inside));
      bytes = readRegularFileSync(from);
    } catch {
      return { ok: false, failure: { code: 'bad_option', key, message: `${file} is not a file in the checkout, so the warm image has no key. Commit it, or list only files the checkout holds` } };
    }

    // A link is followed only to a file of the checkout: what it points to elsewhere on this machine never reaches a sandbox.
    if (path.relative(real, from).startsWith(`..${path.sep}`)) {
      return { ok: false, failure: { code: 'bad_option', key, message: `${file} is a link to a file outside the checkout, so its bytes never go into a warm image. Commit the file itself, or remove it from ${key}` } };
    }

    hash.update(`\0${inside}\0`).update(bytes);
    read.push({ file: inside, from });
  }

  const key = hash.digest('hex').slice(0, 16);
  const cache = read.slice(0, recipe.cache.length);
  const make = recipe.containerfile === undefined ? { prepare: recipe.prepare } : { containerfile: ownFile?.from ?? read[recipe.cache.length]?.from ?? path.resolve(checkout, recipe.containerfile) };

  return { ok: true, plan: { tag: `${WARM_REPOSITORY}:${key}`, key, cache, make } };
}

/**
 * A fresh scratch directory outside the checkout holding copies of the `cache` files, at their paths relative to the
 * checkout, and what removes it.
 */
export function scratchOf(cache: WarmPlan['cache']) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `teamai-warm-${process.pid}-`)));

  for (const { file, from } of cache) {
    const to = path.join(dir, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, readRegularFileSync(from));
    // As a copy would: a script the recipe runs stays executable.
    fs.chmodSync(to, fs.statSync(from).mode & 0o7777);
  }

  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * What runs one build per key at a time in this process: an open of a key another is building waits for that build
 * and gets its outcome; once it settled, the next open of that key looks again.
 */
export function oneBuildPerKey<T>(): (key: string, build: () => Promise<T>) => Promise<T> {
  const building = new Map<string, Promise<T>>();

  return (key, build) => {
    const running = building.get(key);

    if (running) return running;
    const started = build().finally(() => building.delete(key));
    building.set(key, started);

    return started;
  };
}
