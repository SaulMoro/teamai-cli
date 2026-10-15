import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { formatDiagnostic } from '../workflow/parse.js';
import type { DriverIdentity } from '../workflow/types.js';

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

/** Workflows a start line names that its page declares only in prose, as `inputs: { … }` in the same paragraph. */
const DECLARED_IN_PROSE = new Set(['fix']);

interface Start {
  label: string;
  line: number;
  name: string;
  json: string;
  paragraph: string;
}

/** Each `teamai workflow start <name> … --inputs '<json>'` on `page`, and each `--inputs` with a value it could not read as one. */
function startsOf(page: string): { starts: Start[]; unread: string[] } {
  const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
  const starts = [...text.matchAll(/teamai workflow start ([A-Za-z0-9][A-Za-z0-9._-]*)[^\n`']*--inputs '([^'\n]*)'/g)].map((match) => ({
    label: `${page}:${lineOf(match.index)} (${match[1]})`,
    line: lineOf(match.index),
    name: match[1] ?? '',
    json: match[2] ?? '',
    paragraph: text.split(/\n\s*\n/).find((block) => block.includes(match[0])) ?? '',
  }));
  const unread = [...text.matchAll(/--inputs[ =]['"{]/g)]
    .map((match) => lineOf(match.index))
    .filter((line) => !starts.some((start) => start.line === line))
    .map((line) => `${page}:${line}: --inputs is not part of a teamai workflow start line`);
  return { starts, unread };
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
    usageReportEnabled: false,
  };
}

const driver: DriverIdentity = { kind: 'local', machine: 'docs', workspace: '/work' };

/** Writes each complete workflow example on `page` into the team repo, and the prompt files they name. */
function writeExamples(page: string, config: LocalConfig): { byFile: Map<string, string>; failures: string[] } {
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
  return { byFile, failures };
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
    const { byFile, failures } = writeExamples(page, config);
    expect(byFile.size, `${page} has no complete workflow example`).toBeGreaterThan(0);

    const result = await syncWorkflowDefinitions(config, { dryRun: true });
    for (const diagnostic of result.invalid) {
      failures.push(`${byFile.get(diagnostic.file) ?? page}: ${formatDiagnostic(diagnostic)}`);
    }
    for (const file of result.unrunnable) failures.push(`${byFile.get(file) ?? page}: ${file} has no runnable version`);
    expect(failures).toEqual([]);
  });

  it('finds the --inputs lines of workflow start', () => {
    expect(PAGES.flatMap((page) => startsOf(page).starts.map((start) => start.name))).toEqual(expect.arrayContaining(['fan-publish', 'fix']));
  });

  it('declares in prose only workflows that a page starts without an example', () => {
    const inProse = PAGES.flatMap((page) => {
      const { byFile } = writeExamples(page, teamRepo());
      return startsOf(page).starts.filter((start) => !byFile.has(`workflows/${start.name}.yaml`)).map((start) => start.name);
    });
    expect([...DECLARED_IN_PROSE].filter((name) => !inProse.includes(name))).toEqual([]);
  });

  it.each(PAGES)('%s: each workflow start --inputs fits the inputs its workflow declares on the page', async (page) => {
    const config = teamRepo();
    const { byFile } = writeExamples(page, config);
    const { starts, unread } = startsOf(page);
    const failures = [...unread];
    const declared: Start[] = [];
    for (const start of starts) {
      if (!byFile.has(`workflows/${start.name}.yaml`)) {
        const inputs = DECLARED_IN_PROSE.has(start.name) ? /`inputs: (\{[^`]*\})`/.exec(start.paragraph)?.[1] : undefined;
        if (inputs === undefined) {
          failures.push(`${start.label}: workflow "${start.name}" is not an example on the page`);
          continue;
        }
        fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${start.name}.yaml`),
          `schemaVersion: v1alpha1\nname: ${start.name}\ndescription: Declared in prose.\ninputs: ${inputs}\nsteps:\n  - id: run\n    command: node run.js\n`);
      }
      declared.push(start);
    }
    await syncWorkflowDefinitions(config);
    for (const start of declared) {
      let inputs: unknown;
      try {
        inputs = JSON.parse(start.json);
      } catch {
        failures.push(`${start.label}: --inputs is not JSON`);
        continue;
      }
      const started = await startRun(config, start.name, inputs);
      if ('error' in started) {
        failures.push(`${start.label}: ${started.error.code}: ${started.error.message}`);
        continue;
      }
      // Some inputs, such as the `after` of a for_each item, are read only when the first step is leased.
      const next = await leaseNext(config, String(started.data.run), driver);
      if (!('data' in next) || !next.data.lease) failures.push(`${start.label}: the first next leases nothing: ${JSON.stringify(next)}`);
    }
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
