/**
 * The evidence a workflow step left in its attempt's `out/` directory, as the team session archive keeps it beside the
 * session the step ran: each text file masked as the session's transcript is, and every other file listed by name,
 * type, size and hash only, since media cannot be masked for secrets, so its content never leaves the machine.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Text kinds whose content is archived, masked, by extension, with the media type the judge is told. */
const TEXT_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json', '.jsonl': 'application/jsonl', '.md': 'text/markdown',
  '.html': 'text/html', '.xml': 'application/xml', '.csv': 'text/csv', '.yaml': 'application/yaml',
};

/** Media types of the listed kinds a judge is likely to meet, by extension; any other is `application/octet-stream`. */
const LISTED_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.zip': 'application/zip',
};

const EvidenceFileSchema = z.discriminatedUnion('kind', [
  /** A text file, masked, cut to what the caps leave of it. `size` is the file's own, in bytes. */
  z.object({ kind: z.literal('text'), path: z.string().min(1), type: z.string(), size: z.number().int().nonnegative(), text: z.string(), cut: z.boolean() }).strict(),
  /** A file whose content stays on the machine that ran the step. */
  z.object({ kind: z.literal('listed'), path: z.string().min(1), type: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
]);

export const ArchivedEvidenceSchema = z.object({ version: z.literal(1), files: z.array(EvidenceFileSchema) }).strict();

export type ArchivedEvidence = z.infer<typeof ArchivedEvidenceSchema>;

export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;

/** The files of `dir` and below, by their path relative to it with `/`, sorted; a link or other special file is skipped. */
async function regularFiles(dir: string, under = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, under), { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = under === '' ? entry.name : `${under}/${entry.name}`;

    if (entry.isDirectory()) found.push(...await regularFiles(dir, relative));
    else if (entry.isFile()) found.push(relative);
  }

  return found;
}

/** The most of one text file the archive keeps, in bytes of its masked text. */
const FILE_MAX_BYTES = 1024 * 1024;

/** The most text of one step's evidence the archive keeps, in bytes of masked text: the files past it are cut. */
const STEP_MAX_BYTES = 10 * FILE_MAX_BYTES;

/** The largest text file read to be masked: the mask reads a file whole, so a larger one is listed instead. */
const TEXT_READ_MAX_BYTES = 64 * FILE_MAX_BYTES;

/**
 * `text` whole when it fits in `max` bytes, else its first `max` bytes, never ending inside a character, followed by a
 * line that says it was cut. Masked text only: cutting first could keep the head of a secret the mask no longer sees.
 */
function cutAt(text: string, max: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf-8');

  if (bytes.length <= max) return { text, cut: false };
  let end = max;

  // Back off to the first byte of the character the cut falls in.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;

  return { text: `${bytes.subarray(0, end).toString('utf-8')}\n[teamai: cut at ${max} bytes: the archive keeps at most 1 MiB of a file and 10 MiB of a step's evidence]\n`, cut: true };
}

/** `bytes` as text, or undefined when they are not UTF-8: a mask reads only the text it is given. */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) hash.update(chunk);

  return hash.digest('hex');
}

/**
 * The evidence in `dir`, each text file and each path passed through `mask`, or undefined when `dir` holds no file. A
 * `mask` that throws fails the whole collection, so no text leaves unmasked.
 */
async function collect(dir: string, mask: (text: string) => string): Promise<ArchivedEvidence | undefined> {
  const names = await regularFiles(dir).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });

  if (names.length === 0) return undefined;
  const files: EvidenceFile[] = [];
  let left = STEP_MAX_BYTES;

  for (const name of names) {
    const file = path.join(dir, ...name.split('/'));
    const extension = path.extname(name).toLowerCase();
    const textType = TEXT_TYPES[extension];
    const { size } = await fs.stat(file);

    const text = textType === undefined || size > TEXT_READ_MAX_BYTES ? undefined : utf8(await fs.readFile(file));

    if (textType !== undefined && text !== undefined) {
      const kept = cutAt(mask(text), Math.min(FILE_MAX_BYTES, left));
      left -= Math.min(Buffer.byteLength(kept.text, 'utf-8'), left);
      files.push({ kind: 'text', path: mask(name), type: textType, size, ...kept });
      continue;
    }

    files.push({ kind: 'listed', path: mask(name), type: textType ?? LISTED_TYPES[extension] ?? 'application/octet-stream', size, sha256: await sha256Of(file) });
  }

  return { version: 1, files };
}

export const SessionEvidence = { collect } as const;
