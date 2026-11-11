import path from 'node:path';
import { readFileSafe } from '../utils/fs.js';
import { NOT_A_SCORER, scorerSourceHash } from './cache.js';
import { formatScorerDiagnostic, parseScorer, type ScorerDefinition } from './definition.js';
import type { PinnedScorer } from './pin.js';

// The scorer files a teamai-try-scorer run tries, read as `teamai pull` reads them.

export type Refusal = { ok: false; code: string; message: string };

export function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

/** A scorer file read as `teamai pull` reads it, with its path relative to the current directory, or absolute outside it. */
export interface TriedFile {
  scorer: string;
  file: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

/** The scorer file `value` names, relative to the current directory, read and parsed as `teamai pull` parses it. */
async function fileOf(value: string): Promise<TriedFile | Refusal> {
  const full = path.resolve(value);
  const relative = path.relative(process.cwd(), full);
  const file = relative.startsWith('..') || path.isAbsolute(relative) ? full : relative.split(path.sep).join('/');

  if (!file.endsWith('.md') || path.posix.basename(file) === 'README.md') return refused('scorer_invalid', formatScorerDiagnostic({ file, message: NOT_A_SCORER }));
  const content = await readFileSafe(full);

  if (content === null) return refused('scorer_not_found', formatScorerDiagnostic({ file, message: 'could not be read' }));
  const parsed = parseScorer(file, content);

  if (!parsed.ok) return refused('scorer_invalid', parsed.diagnostics.map(formatScorerDiagnostic).join('\n'));

  return { scorer: parsed.definition.name, file, definition: parsed.definition, pin: { sourceHash: scorerSourceHash(content), relativePath: file, content } };
}

/** The scorer files `values` name, read once each, or why they cannot be tried together. */
async function readAll(values: readonly string[]): Promise<{ ok: true; files: TriedFile[] } | Refusal> {
  const read: TriedFile[] = [];

  for (const value of new Set(values)) {
    const one = await fileOf(value);

    if ('ok' in one) return one;
    const twin = read.find((other) => other.scorer === one.scorer);

    if (twin) return refused('invalid_arguments', `--scorer ${twin.file} and --scorer ${one.file} are both scorer ${one.scorer}. Judge them in separate commands.`);
    read.push(one);
  }

  return { ok: true, files: read };
}

export const TriedFile = { readAll } as const;
