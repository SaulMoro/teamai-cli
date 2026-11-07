import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import type { WarmOptions } from './options.js';

// ─── The warm image ──────────────────────────────────────
//
//  An optional image (sbx: a saved template) with the toolchain and the package manager's store already filled, which
//  a provider starts each attempt from instead of its base. It is made at the first open for its key, in a scratch
//  sandbox with the network and no credential, where only copies of the `cache` files are, in a scratch directory
//  outside the checkout:
//
//    key        sha256(base, recipe, each cache file's path and bytes), its first 16 hex digits
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

/** Removes the scratch directories warm builds left whose process no longer runs (a runtime killed while it built). */
export function removeLeftScratch(): void {
  for (const name of fs.readdirSync(os.tmpdir())) {
    const pid = /^teamai-warm-(\d+)-/.exec(name)?.[1];

    if (pid !== undefined && !isRunning(Number(pid))) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
}

/** The most of a failed build's or prepare's output its failure quotes. */
const TAIL = 600;

/** A warm image to have: its tag, its key, the `cache` files it is made with, and how: a command, or a containerfile's path. */
export interface WarmPlan {
  tag: string;
  key: string;
  cache: readonly string[];
  make: { prepare: string } | { containerfile: string };
}

/** The last lines of `output`, for a failure. */
export function tailOf(output: string): string {
  const trimmed = output.trim();

  return trimmed.length > TAIL ? `…${trimmed.slice(-TAIL)}` : trimmed;
}

/**
 * The warm image for `base` and `recipe` with the `cache` files of `checkout`, or `bad_option` on `warm.<key>` naming a
 * file that is not in the checkout.
 */
export function planWarm({ base, recipe, checkout }: { base: string; recipe: WarmOptions; checkout: string }): { ok: true; plan: WarmPlan } | { ok: false; failure: RuntimeFailure } {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ base, recipe }));
  const files = [...recipe.cache.map((file) => ({ file, key: 'warm.cache' })), ...(recipe.containerfile === undefined ? [] : [{ file: recipe.containerfile, key: 'warm.containerfile' }])];

  for (const { file, key } of files) {
    const full = path.resolve(checkout, file);
    const inside = path.relative(checkout, full);

    if (path.isAbsolute(file) || inside.startsWith('..') || inside === '') {
      return { ok: false, failure: { code: 'bad_option', key, message: `${file} is not a path inside the checkout. Give it relative to the checkout, for example package-lock.json` } };
    }

    let bytes: Buffer;

    try {
      bytes = fs.readFileSync(full);
    } catch {
      return { ok: false, failure: { code: 'bad_option', key, message: `${file} is not a file in the checkout, so the warm image has no key. Commit it, or list only files the checkout holds` } };
    }

    hash.update(`\0${inside}\0`).update(bytes);
  }

  const key = hash.digest('hex').slice(0, 16);
  const make = recipe.containerfile === undefined ? { prepare: recipe.prepare } : { containerfile: path.resolve(checkout, recipe.containerfile) };

  return { ok: true, plan: { tag: `${WARM_REPOSITORY}:${key}`, key, cache: recipe.cache, make } };
}

/**
 * A fresh scratch directory outside the checkout holding copies of the `cache` files of `checkout`, at their relative
 * paths, and what removes it.
 */
export function scratchOf({ cache, checkout }: { cache: readonly string[]; checkout: string }): { dir: string; remove: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `teamai-warm-${process.pid}-`)));

  for (const file of cache) {
    const to = path.join(dir, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.resolve(checkout, file), to);
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
