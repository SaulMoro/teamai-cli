import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { formatDiagnostic } from '../workflow/parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = path.join(ROOT, 'docs', 'guide');

// docs/guide/**/workflow*.md, so a new page or language is checked by default. fs.globSync needs Node 22; CI runs Node 20.
const PAGES = fs.readdirSync(GUIDE, { recursive: true, encoding: 'utf8' })
  .filter((file) => /^workflow.*\.md$/.test(path.basename(file)))
  .map((file) => path.posix.join('docs/guide', file.split(path.sep).join('/')))
  .sort();

interface Example {
  label: string;
  source: string;
}

function examplesOf(page: string): Example[] {
  const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
  return [...text.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map((match) => {
    const line = text.slice(0, match.index).split('\n').length + 1;
    const source = match[1] ?? '';
    return { label: `${page}:${line} (${source.split('\n')[0]?.trim()})`, source };
  });
}

function isWorkflow(value: unknown): value is { name?: unknown } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'steps' in value;
}

function promptFiles(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(promptFiles);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, field]) => (key === 'prompt_file' && typeof field === 'string' ? [field] : promptFiles(field)));
}

const dirs: string[] = [];

function teamRepo(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-docs-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow guide examples', () => {
  it('finds the English and Chinese workflow pages', () => {
    expect(PAGES).toContain('docs/guide/workflow.md');
    expect(PAGES).toContain('docs/guide/zh-CN/workflow.md');
  });

  it.each(PAGES)('%s: each yaml block parses, and its complete workflows pass pull together', async (page) => {
    const config = teamRepo();
    const failures: string[] = [];
    const byFile = new Map<string, string>();
    for (const example of examplesOf(page)) {
      const document = parseDocument(example.source);
      if (document.errors.length > 0) {
        failures.push(`${example.label}: ${document.errors[0]?.message}`);
        continue;
      }
      const value: unknown = document.toJS();
      if (!isWorkflow(value)) continue;
      const file = `workflows/${String(value.name)}.yaml`;
      const twin = byFile.get(file);
      if (twin) failures.push(`${example.label}: ${file} is also ${twin}`);
      byFile.set(file, example.label);
      fs.writeFileSync(path.join(config.repo.localPath, file), example.source);
      for (const prompt of promptFiles(value).filter((file) => file.startsWith('prompts/'))) {
        fs.mkdirSync(path.dirname(path.join(config.repo.localPath, prompt)), { recursive: true });
        fs.writeFileSync(path.join(config.repo.localPath, prompt), 'Review the change.\n');
      }
    }
    expect(byFile.size, `${page} has no complete workflow example`).toBeGreaterThan(0);

    const result = await syncWorkflowDefinitions(config, { dryRun: true });
    for (const diagnostic of result.invalid) {
      failures.push(`${byFile.get(diagnostic.file) ?? page}: ${formatDiagnostic(diagnostic)}`);
    }
    for (const file of result.unrunnable) failures.push(`${byFile.get(file) ?? page}: ${file} has no runnable version`);
    expect(failures).toEqual([]);
  });

  it.each(PAGES)('%s: every relative link to a .md file resolves', (page) => {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const missing = [...text.matchAll(/\]\(([^)#\s:]+\.md)(?:#[^)]*)?\)/g)]
      .map((match) => match[1]!)
      .filter((target) => !fs.existsSync(path.join(ROOT, path.dirname(page), target)));
    expect(missing).toEqual([]);
  });
});
