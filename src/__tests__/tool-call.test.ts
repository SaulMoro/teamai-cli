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

  it('an unknown tool name is unknown, whatever its input names', () => {
    expect(classifyToolCall({ tool_name: 'OpenDocument', tool_input: { file_path: '/w/doc.md', command: 'cat doc.md' }, tool_response: {} }))
      .toEqual({ category: 'unknown', paths: [], status: 'success', simple: false });
  });
});
