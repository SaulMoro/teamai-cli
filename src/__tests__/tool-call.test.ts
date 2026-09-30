/**
 * The tool-call classifier's shell parsing (#884), on its public function.
 * The adoption contract itself is covered at the hook seam in
 * recall-attribution.test.ts; these rows pin the command forms a seam row
 * would need too much setup for.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { classifyToolCall } from '../utils/tool-call.js';

const CWD = path.resolve('/w');
const at = (file: string): string => path.resolve(CWD, file);

function shell(command: string, response: unknown = { stdout: '', stderr: '' }): ReturnType<typeof classifyToolCall> {
  return classifyToolCall({ tool_name: 'Bash', tool_input: { command }, tool_response: response, cwd: CWD });
}

describe('classifyToolCall', () => {
  it.each<[string, string[]]>([
    ['cat doc.md', ['doc.md']],
    ['cat -n a.md b.md', ['a.md', 'b.md']],
    ['cat -- -odd.md', ['-odd.md']],
    ['/bin/cat doc.md', ['doc.md']],
    ['LC_ALL=C cat doc.md', ['doc.md']],
    ['cat "my doc.md"', ['my doc.md']],
    ['cat doc.md\n', ['doc.md']],
    ['cat doc.md 2>/dev/null', ['doc.md']],
    ['bat --style plain doc.md', ['doc.md']],
    ['batcat -r 1:40 doc.md', ['doc.md']],
    ['less -p timeout doc.md', ['doc.md']],
    ['more doc.md', ['doc.md']],
    ['head -n 5 doc.md', ['doc.md']],
    ['head -5 doc.md', ['doc.md']],
    ['tail -n +10 doc.md', ['doc.md']],
    ['nl -ba doc.md', ['doc.md']],
    ["nl -s ' ' doc.md", ['doc.md']],
    ['sed -n 5p doc.md', ['doc.md']],
    ["sed -n '1,80p' doc.md", ['doc.md']],
    ["sed -ne '1,5p' doc.md", ['doc.md']],
    ['sed -n -e 1p -e 9,12p doc.md', ['doc.md']],
    ['sed --quiet --expression=3p doc.md', ['doc.md']],
  ])('%j reads %j', (command, files) => {
    expect(shell(command)).toMatchObject({ category: 'read', paths: files.map(at), simple: true, status: 'success' });
  });

  it.each([
    'cat',
    'cat -',
    'cat *.md',
    'cat $(ls)',
    'cat "$HOME/doc.md"',
    'cat doc.md > copy.md',
    'cat notes.txt > doc.md',
    'cat < doc.md',
    'cat doc.md >&2',
    'cat doc.md && echo ok',
    'cat doc.md || true',
    'cat doc.md; echo ok',
    'cat doc.md &',
    'cat doc.md\necho ok',
    'echo x | cat doc.md',
    'echo "cat doc.md"',
    'sed 1p doc.md',
    "sed -n 's/a/b/p' doc.md",
    'sed -n -i 1p doc.md',
    'sed -i.bak -n 1p doc.md',
    'sed --in-place -n 1p doc.md',
    'sed -n -f print.sed doc.md',
    'nl -s doc.md',
    'head -n 5',
  ])('%j is no read', (command) => {
    expect(shell(command)).toMatchObject({ category: 'shell', paths: [], command });
  });

  it('a pipeline that starts with the reader is a read, but not a simple one', () => {
    expect(shell('cat doc.md 2>&1 | head -n 20')).toMatchObject({ category: 'read', paths: [at('doc.md')], simple: false });
  });

  it('a Read tool reads its file_path, resolved against the cwd when there is one', () => {
    expect(classifyToolCall({ tool_name: 'Read', tool_input: { file_path: 'doc.md' }, tool_response: {}, cwd: CWD }))
      .toEqual({ category: 'read', paths: [at('doc.md')], status: 'success', simple: true });
    expect(classifyToolCall({ tool_name: 'read_file', tool_input: { file_path: 'learnings/doc.md' }, tool_response: {} }))
      .toMatchObject({ category: 'read', paths: ['learnings/doc.md'] });
  });

  it('status: a plain-string response (Codex) is unknown, a non-zero exitCode is a failure', () => {
    expect(shell('cat doc.md', 'the file text')).toMatchObject({ status: 'unknown', output: 'the file text' });
    expect(shell('cat doc.md', { stdout: 'x', exitCode: 0 })).toMatchObject({ status: 'success', output: 'x' });
    expect(shell('cat doc.md', { stdout: '', exitCode: 1 })).toMatchObject({ status: 'failure' });
  });

  it.each<[string, string, string[]]>([
    ['grep -rn timeout learnings', 'learnings/a.md:3:x\nlearnings/sub/b.md:9:y', ['learnings/a.md', 'learnings/sub/b.md']],
    ['grep -e timeout -e pool learnings', 'learnings/a.md:x', ['learnings/a.md']],
    ['grep -A 2 timeout learnings', 'learnings/a.md:3:x\nlearnings/a.md-4-y', ['learnings/a.md']],
    ['grep --include=*.md -rn timeout .', './learnings/a.md:3:x', ['learnings/a.md']],
    ['egrep -rn "a|b" learnings 2>/dev/null', 'learnings/a.md:1:a', ['learnings/a.md']],
    ['rg -n timeout', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['rg -g "*.md" -t md timeout learnings', 'learnings/a.md:x', ['learnings/a.md']],
    ['rg -L timeout learnings', 'learnings/a.md:x', ['learnings/a.md']],
    ['rg -n timeout learnings/*.md', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['git grep -n timeout', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['ag timeout learnings', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['ack --match timeout learnings', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['grep -n timeout learnings/a.md', '3:x', ['learnings/a.md']],
    ['grep -H timeout learnings/a.md', 'learnings/a.md:x', ['learnings/a.md']],
    ['grep -rn timeout learnings', 'Found 2 matches\nlearnings/a.md:', ['learnings/a.md']],
  ])('%j with output %j shows lines of %j', (command, stdout, files) => {
    expect(shell(command, { stdout })).toMatchObject({ category: 'search', paths: files.map(at), simple: true });
  });

  // The hook reads no file, so it cannot tell a lone file operand from a directory: it records the operand,
  // which only ever equals a doc's path when it is that doc.
  it.each<[string, string]>([
    ['grep -rn timeout learnings', 'learnings/a.md\nlearnings/b.md'],
    ['grep -rn timeout learnings', 'other/a.md:3:x'],
    ['grep timeout learnings/a.md', '../b.md: see b'],
  ])('%j with output %j shows the lines of its operand only', (command, stdout) => {
    expect(shell(command, { stdout }).paths).toEqual([at(command.split(' ').pop()!)]);
  });

  it.each<[string, string]>([
    ['grep -rn timeout learnings', ''],
    ['grep -rn timeout learnings other', 'learnings/a.md\nthird/a.md:3:x'],
    ['grep -c timeout learnings/a.md', '3'],
    ['grep -rnc timeout learnings', 'learnings/a.md:3'],
    ['rg --count-matches timeout learnings', 'learnings/a.md:3'],
    ['git grep --count timeout', 'learnings/a.md:3'],
    ['grep -rn timeout learnings/a.md | wc -l', '3'],
    ['grep -rn timeout learnings > hits.txt', 'learnings/a.md:3:x'],
    ['grep -rn timeout learnings && echo ok', 'learnings/a.md:3:x'],
  ])('%j with output %j shows no file\'s lines', (command, stdout) => {
    expect(shell(command, { stdout }).paths).toEqual([]);
  });

  it.each([
    'grep -l timeout learnings', 'grep -rL timeout learnings', 'grep --files-with-matches timeout learnings',
    'rg -l timeout', 'rg --files learnings', 'git grep --name-only timeout', 'ag -g md learnings', 'ack -f learnings',
    'ls learnings', 'ls -la learnings/a.md', 'find learnings -name "*.md"', 'fd md learnings', 'tree learnings',
    'git ls-files learnings',
  ])('%j is a listing', (command) => {
    expect(shell(command, { stdout: 'learnings/a.md:3:x' })).toMatchObject({ category: 'list', paths: [] });
  });

  it('a search tool shows the lines of the files its content names, never of its filenames list', () => {
    const grep = (input: Record<string, unknown>, response: unknown, agent?: string): ReturnType<typeof classifyToolCall> =>
      classifyToolCall({ tool_name: 'Grep', tool_input: { pattern: 'x', ...input }, tool_response: response, cwd: CWD }, agent);
    expect(grep({ path: 'learnings' }, { filenames: [at('learnings/a.md')] })).toMatchObject({ category: 'list', paths: [] });
    expect(grep({ path: 'learnings', output_mode: 'content' }, { content: `${at('learnings/a.md')}:3:x` }))
      .toMatchObject({ category: 'search', paths: [at('learnings/a.md')] });
    expect(grep({ output_mode: 'content' }, { content: 'learnings/a.md:3:x' })).toMatchObject({ paths: [at('learnings/a.md')] });
    expect(grep({ path: 'learnings', output_mode: 'count' }, { content: `${at('learnings/a.md')}:3` })).toMatchObject({ paths: [] });
    expect(classifyToolCall({ tool_name: 'search_content', tool_input: { pattern: 'x', path: at('learnings/a.md') }, tool_response: {} }))
      .toMatchObject({ category: 'list' });
    // OpenCode: an absolute `path:` header, then `  Line N: text`.
    expect(classifyToolCall({ tool_name: 'grep', tool_input: { pattern: 'x' }, tool_response: `Found 1 matches\n${at('learnings/a.md')}:\n  Line 3: x`, cwd: CWD }))
      .toMatchObject({ category: 'search', paths: [at('learnings/a.md')], status: 'unknown', simple: true });
    // OMP's markdown tree and Cursor's Grep: no evidence yet.
    for (const agent of ['omp', 'cursor']) {
      expect(classifyToolCall({ tool_name: agent === 'omp' ? 'grep' : 'Grep', tool_input: { pattern: 'x', path: at('learnings/a.md'), output_mode: 'content' }, tool_response: '3:x', cwd: CWD }, agent))
        .toMatchObject({ category: 'search', paths: [] });
    }
  });

  it('an unknown tool name is unknown, whatever its input names', () => {
    expect(classifyToolCall({ tool_name: 'OpenDocument', tool_input: { file_path: '/w/doc.md', command: 'cat doc.md' }, tool_response: {} }))
      .toEqual({ category: 'unknown', paths: [], status: 'success', simple: false });
  });
});
