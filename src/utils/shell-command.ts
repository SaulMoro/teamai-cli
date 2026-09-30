/**
 * The one shell command-line parser (#884): an agent's shell call split into
 * simple commands, and what the call did with files.
 *
 * Only a call that surely ran its reader is a read: one simple command, or a
 * pipeline that starts with it. Any `;`, `&&`, `||` or `&` means the read may
 * never have run, so the call is no read. The files are the reader's file
 * operands only: never a flag's value, a sed script or a redirect target.
 */

/** An operator that ends a simple command. A newline is a `;`. */
export type ShellOperator = ';' | '&&' | '||' | '|' | '&';

export interface Redirect {
  /** The operator, with the file descriptor written before it: `>`, `2>`, `2>&`, `<`, `&>`, `<<`… */
  op: string;
  /** The word after it: a file, or the descriptor a `>&` duplicates. */
  target: string;
}

export interface SimpleCommand {
  /** Its words with the quotes removed, redirects left out. */
  words: string[];
  redirects: Redirect[];
  /** The operator after it; null for the last command. */
  op: ShellOperator | null;
}

/** What a shell call did with files. Ticket 06 adds `search` and `list`, ticket 07 PowerShell's readers. */
export interface ShellClassification {
  category: 'read' | 'shell';
  /** The files it read, as written in the command. */
  paths: string[];
  /** True when the reader is the call's only command, not the head of a pipeline. */
  simple: boolean;
}

const REDIRECT = /^(?:&>>?|<<<|<<-?|<>|<&|>>|>&|>\||<|>)/;

/**
 * The simple commands of a shell command line, split on `;`, `&&`, `||`, `|`,
 * `&` and newlines outside quotes, each with the operator after it. A
 * redirect (`2>&1`, `> out`, `<in`) is kept apart with its target. A
 * backslash escapes only `"` or `\` inside double quotes, and a newline
 * outside quotes, so a Windows path stays whole.
 */
export function simpleCommands(command: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [], op: null };
  let word: string | null = null;
  let quote: string | null = null;
  let redirect: string | null = null;
  const endWord = (): void => {
    if (word === null) return;
    if (redirect !== null) current.redirects.push({ op: redirect, target: word });
    else current.words.push(word);
    word = null;
    redirect = null;
  };
  const endCommand = (op: ShellOperator | null): void => {
    endWord();
    if (redirect !== null) current.redirects.push({ op: redirect, target: '' });
    redirect = null;
    // An empty command (a blank line, a doubled `;`) ends nothing: the previous command keeps its operator.
    if (current.words.length === 0 && current.redirects.length === 0) return;
    current.op = op;
    commands.push(current);
    current = { words: [], redirects: [], op: null };
  };
  const line = command.trimEnd();
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (next === '"' || next === '\\')) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && next === '\n') {
      i++;
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      // A file descriptor written just before the operator belongs to it: `2>&1`.
      const fd = word !== null && /^\d+$/.test(word) ? word : '';
      if (fd) word = null;
      else endWord();
      const op = REDIRECT.exec(line.slice(i))![0];
      i += op.length - 1;
      redirect = fd + op;
    } else if (c === '|') {
      if (next === '|' || next === '&') i++;
      endCommand(next === '|' ? '||' : '|');
    } else if (c === '&') {
      if (next === '&') i++;
      endCommand(next === '&' ? '&&' : '&');
    } else if (c === ';' || c === '\n') {
      endCommand(';');
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? '') + c;
    }
  }
  endCommand(null);
  return commands;
}

/** A command's words from its command word on, after any `NAME=value` assignments. */
export function commandWords(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return words.slice(i);
}

/**
 * The operands of `args`, skipping flags and the values of `valueFlags`.
 * After `--` every word is an operand; a lone `-` (stdin) is none.
 */
function operands(args: string[], valueFlags: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (valueFlags.includes(a)) i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out.filter((a) => a !== '-');
}

/** A sed script that only prints a line or a range of lines: `5p`, `1,80p`. */
const SED_PRINT = /^\d+(?:,\d+)?p$/;

/**
 * The files `sed` reads when it only prints lines: quiet (`-n`), never in
 * place (`-i`), and every script a line or a range print. The first operand
 * is the script unless `-e` gave one.
 */
function sedPrintFiles(args: string[]): string[] {
  let quiet = false;
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-')) rest.push(a);
    else if (a === '--in-place' || a.startsWith('--in-place=') || (!a.startsWith('--') && a.includes('i'))) return [];
    else if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (a.startsWith('--expression=')) scripts.push(a.slice('--expression='.length));
    // A script from a file is unknown.
    else if (a === '-f' || a === '--file' || a.startsWith('--file=')) return [];
    else if (a === '-l' || a === '--line-length') i++;
    else if (a === '--quiet' || a === '--silent') quiet = true;
    else if (!a.startsWith('--')) {
      // A cluster of short flags, such as `-nE`; a trailing `e` takes the next word as the script.
      if (a.includes('n')) quiet = true;
      if (a.endsWith('e')) scripts.push(args[++i] ?? '');
    }
  }
  if (!quiet) return [];
  if (scripts.length === 0 && rest.length > 0) scripts.push(rest.shift()!);
  return scripts.length > 0 && scripts.every((s) => SED_PRINT.test(s)) ? operands(rest) : [];
}

const HEAD_TAIL_VALUE_FLAGS = ['-n', '-c', '--lines', '--bytes'];
const BAT_VALUE_FLAGS = ['-l', '--language', '-H', '--highlight-line', '-r', '--line-range', '-m', '--map-syntax',
  '--theme', '--style', '--tabs', '--terminal-width', '--wrap', '--color', '--italic-text', '--decorations',
  '--paging', '--pager', '--file-name'];

/**
 * The reader verbs, each giving the files a call reads. Ported from the
 * classification in Codex's codex-rs/shell-command/src/parse_command.rs
 * (Apache-2.0).
 */
const READERS: Record<string, (args: string[]) => string[]> = {
  cat: (args) => operands(args),
  bat: (args) => operands(args, BAT_VALUE_FLAGS),
  batcat: (args) => operands(args, BAT_VALUE_FLAGS),
  less: (args) => operands(args, ['-p', '-P', '-x', '-y', '-z', '-j', '-b', '-h', '-o', '-O', '-t', '-T',
    '--pattern', '--prompt', '--tabs', '--shift', '--jump-target']),
  more: (args) => operands(args, ['-n', '--lines']),
  head: (args) => operands(args, HEAD_TAIL_VALUE_FLAGS),
  tail: (args) => operands(args, [...HEAD_TAIL_VALUE_FLAGS, '-s', '--sleep-interval', '--pid', '--max-unchanged-stats']),
  nl: (args) => operands(args, ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w',
    '--body-numbering', '--section-delimiter', '--footer-numbering', '--header-numbering', '--line-increment',
    '--join-blank-lines', '--number-format', '--number-separator', '--starting-line-number', '--number-width']),
  sed: sedPrintFiles,
};

/** A word the shell would expand, so it names no file as written. */
const EXPANDS = /[$`*?[\]{}()]/;

/**
 * The files one simple command reads, or none when it is no reader. Only a
 * stderr redirect (`2>/dev/null`, `2>&1`) is allowed: with its input or
 * output redirected, what the agent saw is not the file.
 */
function readerFiles(command: SimpleCommand): string[] {
  const [verb, ...args] = commandWords(command.words);
  const read = verb === undefined ? undefined : READERS[verb.split('/').pop()!];
  if (!read || !command.redirects.every((r) => r.op.startsWith('2>'))) return [];
  const files = read(args);
  return files.some((f) => EXPANDS.test(f)) ? [] : files;
}

/**
 * What a shell command line did with files: a read when it is one reader
 * command, or a pipeline that starts with one; otherwise just a shell call.
 */
export function classifyShellCommand(command: string): ShellClassification {
  const commands = simpleCommands(command);
  const pipeline = commands.every((c, i) => c.op === (i === commands.length - 1 ? null : '|'));
  const paths = pipeline && commands.length > 0 ? readerFiles(commands[0]) : [];
  return paths.length > 0
    ? { category: 'read', paths, simple: commands.length === 1 }
    : { category: 'shell', paths: [], simple: false };
}
