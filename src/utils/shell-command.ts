/**
 * The one shell command-line parser (#884): an agent's shell call split into
 * simple commands, and what the call did with files.
 *
 * A call is a read, a search or a listing when it is one simple command, or a
 * pipeline that starts with it. A list (`;`, `&&`, `||`) is a read when any of
 * its pipelines reads, except one after `||`; any `&` makes the call neither.
 * The files are the command's file operands only: never a flag's value, a sed
 * script, a search pattern or a redirect target.
 */
import { isAbsolutePath } from './agent-path.js';

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

/** What a shell call did with files. */
export interface ShellClassification {
  category: 'read' | 'search' | 'list' | 'shell';
  /**
   * As written in the command. A read: the files it read. A search: where it
   * searched, the part of each operand before any glob (`.` for the cwd), or
   * none when it prints counts, not lines.
   */
  paths: string[];
  /** A search's only file or directory operand, when it has one with nothing to expand. */
  target?: string;
  /** True when the reader or search is the call's only command, not the head of a pipeline or an item of a list. */
  simple: boolean;
  /** A read's or search's command word, as written: `cat`, `/bin/cat`. A list's are every read's, one after `||` included. */
  verbs: string[];
}

const REDIRECT = /^(?:&>>?|<<<|<<-?|<>|<&|>>|>&|>\||<|>)/;

/** The characters an unquoted backslash escapes: whitespace and those the shell gives a meaning. */
const ESCAPABLE = /[\s'"\\$`()&;|<>*?#!]/;

const HOME_REF = /(?:~|\$HOME|\$\{HOME\})(?=[\\/])/y;

function homeRefLength(line: string, at: number): number {
  HOME_REF.lastIndex = at;
  return HOME_REF.exec(line)?.[0].length ?? 0;
}

/**
 * The simple commands of a shell command line, split on `;`, `&&`, `||`, `|`,
 * `&` and newlines outside quotes, each with the operator after it. A
 * redirect (`2>&1`, `> out`, `<in`) is kept apart with its target. An
 * unquoted `#` at the start of a word begins a comment that runs to the end
 * of the line. Outside quotes a backslash escapes whitespace or a character
 * the shell gives a meaning (`my\ doc.md`), and joins a line to the next;
 * before any other character it is kept, so an unquoted Windows path
 * (`C:\kb\x.md`) stays whole. Inside double quotes it escapes only `"`,
 * `\` or `$`, and inside single quotes nothing. Given `home`, `$HOME/` and
 * `${HOME}/` expand outside single quotes; `~/` expands only unquoted.
 */
export function simpleCommands(command: string, home?: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [], op: null };
  let word: string | null = null;
  const stack: ("'" | '"' | '`' | ')')[] = [];
  let redirect: string | null = null;
  const heredocs: { stripTabs: boolean; delimiter: string | null }[] = [];
  const isHeredoc = (): boolean => redirect !== null && /^\d*<<-?$/.test(redirect);
  const endWord = (): void => {
    if (word === null) return;
    if (redirect !== null) {
      if (isHeredoc()) heredocs.push({ stripTabs: redirect.endsWith('-'), delimiter: word });
      current.redirects.push({ op: redirect, target: word });
    } else current.words.push(word);
    word = null;
    redirect = null;
  };
  const endCommand = (op: ShellOperator | null): void => {
    endWord();
    if (redirect !== null) {
      if (isHeredoc()) heredocs.push({ stripTabs: false, delimiter: null });
      current.redirects.push({ op: redirect, target: '' });
    }
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
    const top = stack.at(-1);
    if (top === "'" || top === '"' || top === '`') {
      if (c === top) {
        if (top === '`' || stack.length > 1) word += c;
        stack.pop();
      } else if (c === '\\' && top !== "'" && next === '\n') i++;
      else if (c === '\\' && top !== "'" && (next === top || next === '\\' || next === '$' || next === '`')) {
        if (stack.length > 1) word += c;
        word += line[++i];
      } else if (top === '"' && c === '$' && next === '(') {
        stack.push(')');
        word += '$(';
        i++;
      } else if (top === '"' && c === '`') {
        stack.push('`');
        word += c;
      } else if (top === '"' && c === '$' && home !== undefined && !isHeredoc() && homeRefLength(line, i) > 0) {
        i += homeRefLength(line, i) - 1;
        word += home;
      } else word += c;
    } else if (c === '"' || c === "'") {
      stack.push(c);
      if (stack.length > 1) word = (word ?? '') + c;
      else word ??= '';
    } else if (c === '`') {
      stack.push(c);
      word = (word ?? '') + c;
    } else if (c === '\\' && next === '\n') {
      i++;
    } else if (c === '\\' && next !== undefined && (ESCAPABLE.test(next) || isHeredoc())) {
      if (stack.length > 0) word = (word ?? '') + c;
      word = (word ?? '') + next;
      i++;
    } else if (top === ')') {
      if (c === '(') stack.push(')');
      else if (c === ')') stack.pop();
      if (c === '#' && /(?:^|[\s(;|&])$/.test(word ?? '')) {
        while (i + 1 < line.length && line[i + 1] !== '\n') i++;
      } else word += c;
    } else if (c === '(') {
      stack.push(')');
      word = (word ?? '') + c;
    } else if (c === '#' && word === null) {
      // A `#` that starts a word starts a comment, up to the newline; `a#b` is a word.
      while (i + 1 < line.length && line[i + 1] !== '\n') i++;
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
      if (c === '\n' && heredocs.length > 0) {
        for (const { stripTabs, delimiter } of heredocs) {
          if (delimiter === null) return [];
          let matched = false;
          while (i < line.length) {
            const start = i + 1;
            if (start > line.length) break;
            const nl = line.indexOf('\n', start);
            const end = nl === -1 ? line.length : nl;
            const raw = line.slice(start, end).replace(/\r$/, '');
            i = end;
            if ((stripTabs ? raw.replace(/^\t+/, '') : raw) === delimiter) {
              matched = true;
              break;
            }
          }
          if (!matched) return [];
        }
        heredocs.length = 0;
      }
    } else if (/\s/.test(c)) {
      endWord();
    } else if (word === null && home !== undefined && !isHeredoc() && homeRefLength(line, i) > 0) {
      i += homeRefLength(line, i) - 1;
      word = home;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (stack.length > 0 || heredocs.length > 0) return [];
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

/** Get-Content's parameters that name its files, and its switches: every other parameter takes a value. */
const GET_CONTENT_PATHS = new Set(['path', 'literalpath', 'pspath', 'lp']);
const GET_CONTENT_SWITCHES = new Set(['raw', 'wait', 'force', 'asbytestream', 'verbose', 'debug']);

/**
 * The files PowerShell's Get-Content reads: its positional operands and the
 * values of `-Path` and `-LiteralPath`, written `-Path x` or `-Path:x`.
 * Parameter names are case-insensitive; an unknown one takes the next word as
 * its value, so the word is never taken for a file.
 */
function getContentFiles(args: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const param = /^-([A-Za-z]+)(:?)(.*)$/.exec(args[i]);
    if (!param) {
      files.push(args[i]);
      continue;
    }
    const [, name, colon, inline] = param;
    if (GET_CONTENT_SWITCHES.has(name.toLowerCase())) continue;
    const value = colon ? inline : args[++i];
    if (GET_CONTENT_PATHS.has(name.toLowerCase()) && value) files.push(value);
  }
  return files;
}

/**
 * PowerShell's readers, looked up in lowercase since PowerShell ignores case:
 * Get-Content and its aliases `gc`, `type` (cmd's too) and `cat`. `cat` as
 * written in lowercase is POSIX cat's, which reads `cat -Path x` the same.
 */
const POWERSHELL_READERS: Record<string, (args: string[]) => string[]> = {
  'get-content': getContentFiles,
  gc: getContentFiles,
  type: getContentFiles,
  cat: getContentFiles,
};

/**
 * The aliases that read only in PowerShell or cmd: in a POSIX shell `type` is
 * a builtin that prints what a name is, and `gc` is no command. They count
 * under a PowerShell tool, or when every file is a Windows path.
 */
const WINDOWS_ONLY_READERS = new Set(['type', 'gc']);

/** A Windows path: a drive letter, or any `\` (`.\x.md`, a UNC `\\server\share\x.md`). */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]|\\/;

/** The shell the call ran in, when the tool names it. */
export interface ShellFlavor {
  /** The agent's PowerShell tool ran it. */
  powershell?: boolean;
  /** The home directory the shell expands a leading `~`, `$HOME` or `${HOME}` before `/` or `\` to (`simpleCommands`). */
  home?: string;
}

/**
 * A search verb's flags, each written `-x` or `--name`: those that take a
 * value, those whose value is the pattern (so no operand is), and those that
 * make it print file names or counts instead of lines.
 */
interface SearchVerb {
  values: readonly string[];
  patterns: readonly string[];
  lists: readonly string[];
  counts: readonly string[];
}

const GREP: SearchVerb = {
  values: ['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context',
    '--before-context', '--context', '--directories', '--devices', '--include', '--exclude', '--exclude-dir',
    '--exclude-from', '--label', '--binary-files', '--group-separator'],
  patterns: ['-e', '-f', '--regexp', '--file'],
  lists: ['-l', '-L', '--files-with-matches', '--files-without-match'],
  counts: ['-c', '--count'],
};

/**
 * The search verbs, each with its flags; `git grep` is `git-grep`. Ported from
 * the same Codex classification as the readers.
 */
const SEARCHERS: Record<string, SearchVerb> = {
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  'git-grep': {
    values: ['-e', '-f', '-m', '-A', '-B', '-C', '--regexp', '--file', '--max-count', '--after-context',
      '--before-context', '--context', '--max-depth', '--threads'],
    patterns: GREP.patterns,
    lists: [...GREP.lists, '-O', '--name-only', '--open-files-in-pager'],
    counts: GREP.counts,
  },
  rg: {
    values: ['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-M', '-j', '-r', '-E', '-d', '--regexp', '--file',
      '--glob', '--iglob', '--type', '--type-not', '--type-add', '--type-clear', '--max-count', '--after-context',
      '--before-context', '--context', '--max-columns', '--threads', '--replace', '--encoding', '--max-depth',
      '--max-filesize', '--sort', '--sortr', '--pre', '--pre-glob', '--ignore-file', '--context-separator',
      '--path-separator', '--field-match-separator', '--field-context-separator', '--colors', '--color', '--engine'],
    patterns: GREP.patterns,
    // rg's -L follows symlinks.
    lists: ['-l', '--files', '--files-with-matches', '--files-without-match', '--type-list'],
    counts: ['-c', '--count', '--count-matches'],
  },
  ag: {
    values: ['-A', '-B', '-C', '-G', '-g', '-m', '-p', '--after', '--before', '--context', '--file-search-regex',
      '--max-count', '--ignore', '--ignore-dir', '--depth', '--path-to-ignore', '--pager', '--workers'],
    patterns: [],
    lists: ['-g', '-l', '-L', '--files-with-matches', '--files-without-matches', '--filename-pattern', '--list-file-types'],
    counts: ['-c', '--count'],
  },
  ack: {
    values: ['-A', '-B', '-C', '-g', '-m', '--after-context', '--before-context', '--context', '--max-count', '--match',
      '--type', '--ignore-dir', '--output', '--pager'],
    patterns: ['--match'],
    lists: ['-f', '-g', '-l', '-L', '--files-with-matches', '--files-without-matches'],
    counts: ['-c', '--count'],
  },
};

/** The list verbs: they show paths, never a file's lines. `git ls-files` is `git-ls-files`. */
const LISTERS = new Set(['ls', 'find', 'fd', 'tree', 'git-ls-files']);

/** A word the shell would expand, so it names no file as written. */
const EXPANDS = /[$`*?[\]{}()]/;

/** What a search prints, from its flags, and its file or directory operands. */
function searchArgs(args: string[], verb: SearchVerb): { shows: 'lines' | 'paths' | 'counts'; operands: string[] } {
  let shows: 'lines' | 'paths' | 'counts' = 'lines';
  let pattern = false;
  const words: string[] = [];
  const flag = (f: string): void => {
    if (verb.lists.includes(f)) shows = 'paths';
    else if (verb.counts.includes(f) && shows === 'lines') shows = 'counts';
    if (verb.patterns.includes(f)) pattern = true;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      flag(name);
      if (eq === -1 && verb.values.includes(name)) i++;
    } else if (a.startsWith('-') && a.length > 1) {
      // A cluster of short flags, such as `-rn`: one that takes a value takes the rest of it, or the next word.
      for (let j = 1; j < a.length; j++) {
        const f = `-${a[j]}`;
        flag(f);
        if (verb.values.includes(f)) {
          if (j === a.length - 1) i++;
          break;
        }
      }
    } else {
      words.push(a);
    }
  }
  return { shows, operands: pattern ? words : words.slice(1) };
}

/**
 * Where a search operand points: its part before the first segment with a
 * glob or a variable, split on `/` or `\\`. A root (`/`, `C:\\`) keeps its
 * separator.
 */
function searchRoot(operand: string): string {
  const glob = /(?:^|[\\/])[^\\/]*[$`*?[\]{}()]/.exec(operand);
  if (!glob) return operand;
  const dir = operand.slice(0, glob.index + (glob.index === 0 && !/^[\\/]/.test(operand) ? 0 : 1));
  if (/^(?:[A-Za-z]:)?[\\/]$/.test(dir)) return dir;
  return dir.replace(/[\\/]$/, '') || '.';
}

/** A command word's name: its base name, without `.exe`. */
export function commandName(word: string): string {
  return word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
}

const SHELL: ShellClassification = { category: 'shell', paths: [], simple: false, verbs: [] };

/**
 * What one simple command did with files. Only a stderr redirect
 * (`2>/dev/null`, `2>&1`) is allowed: with its input or output redirected,
 * what the agent saw is not the file.
 */
function classifySimple(command: SimpleCommand, simple: boolean, flavor: ShellFlavor): ShellClassification {
  const [verb, ...rest] = commandWords(command.words);
  if (verb === undefined || !command.redirects.every((r) => r.op.startsWith('2>'))) return SHELL;
  // By path on either platform, `.exe` too: `C:\\…\\cat.exe`, `Microsoft.PowerShell.Management\\Get-Content`.
  const base = commandName(verb);
  const name = base === 'git' && rest.length > 0 ? `git-${rest[0]}` : base;
  const args = name === base ? rest : rest.slice(1);

  // Own keys only: a verb like `constructor` must not hit Object.prototype.
  const read = (Object.hasOwn(READERS, name) ? READERS[name] : undefined)
    ?? (Object.hasOwn(POWERSHELL_READERS, name.toLowerCase()) ? POWERSHELL_READERS[name.toLowerCase()] : undefined);
  if (read) {
    const files = read(args);
    if (WINDOWS_ONLY_READERS.has(name.toLowerCase()) && !flavor.powershell && !files.every((f) => WINDOWS_PATH.test(f))) return SHELL;
    return files.length > 0 && !files.some((f) => EXPANDS.test(f)) ? { category: 'read', paths: files, simple, verbs: [verb] } : SHELL;
  }
  if (LISTERS.has(name)) return { category: 'list', paths: [], simple, verbs: [] };
  const search = Object.hasOwn(SEARCHERS, name) ? SEARCHERS[name] : undefined;
  if (!search) return SHELL;
  const { shows, operands: roots } = searchArgs(args, search);
  if (shows === 'paths') return { category: 'list', paths: [], simple, verbs: [] };
  if (shows === 'counts') return { category: 'search', paths: [], simple, verbs: [verb] };
  const target = roots.length === 1 && !EXPANDS.test(roots[0]) ? roots[0] : undefined;
  return { category: 'search', paths: roots.length > 0 ? roots.map(searchRoot) : ['.'], ...(target ? { target } : {}), simple, verbs: [verb] };
}

/** The commands, besides reads, searches and listings, after which a relative path still resolves against the call's cwd. */
const KEEPS_CWD = new Set(['pwd', 'echo', 'printf', 'test', '[', '[[', 'set', 'true', 'false', ':']);

/** The commands that always exit 0 without depending on arguments or system state. */
const ALWAYS_SUCCEEDS = new Set(['true', ':', 'echo', 'pwd']);

/** The commands that terminate the shell process or script. */
const TERMINATES_SHELL = new Set(['exit', 'exec', 'return', 'logout', 'throw']);

/** The commands that terminate the shell or the current control flow before later list items can run. */
const TERMINATES_LIST = new Set([...TERMINATES_SHELL, 'break', 'continue']);

/**
 * What a shell command line did with files: a read, a search or a listing
 * when it is one such command, or a pipeline that starts with one. A list of
 * pipelines (`;`, `&&`, `||`) is a read, never a simple one, of the files its
 * reading pipelines read when they are guaranteed to have run. After a command
 * that is no read, search or listing and whose command word is not in
 * KEEPS_CWD, only absolute paths count; an assignment alone (`X=1`) has no
 * command word and keeps the cwd. Anything else, a line with an `&`, and a
 * line ending in `|`, `&&` or `||` is just a shell call.
 */
export function classifyShellCommand(command: string, flavor: ShellFlavor = {}): ShellClassification {
  const commands = simpleCommands(command, flavor.home);
  const last = commands.at(-1);
  // A line that ends in `|`, `&&` or `||` runs nothing; a trailing `;` changes nothing.
  if (last === undefined || (last.op !== null && last.op !== ';') || commands.some((c) => c.op === '&')) return SHELL;
  const isList = commands.slice(0, -1).some((c) => c.op !== '|');
  if (!isList) return classifySimple(commands[0], commands.length === 1, flavor);
  return classifyList(commands, flavor);
}

const COMPOUND_OPENERS = new Map<string, string>([
  ['if', 'fi'],
  ['for', 'done'],
  ['while', 'done'],
  ['until', 'done'],
  ['select', 'done'],
  ['case', 'esac'],
  ['{', '}'],
]);
const COMPOUND_CLOSERS = new Set(['fi', 'done', 'esac', '}']);
const COMPOUND_CLAUSES = new Map<string, string>([
  ['then', 'fi'],
  ['elif', 'fi'],
  ['else', 'fi'],
  ['do', 'done'],
]);

/** Whether a single-command pipeline always exits 0 without depending on external state. */
function isUnconditionalZero(command: SimpleCommand): boolean {
  if (!command.redirects.every((r) => r.op.startsWith('2>'))) return false;
  const [word] = commandWords(command.words);
  return word === undefined || ALWAYS_SUCCEEDS.has(commandName(word).toLowerCase());
}

/** Whether a command is known to fail unconditionally. */
function isKnownFailure(command: SimpleCommand): boolean {
  const [word] = commandWords(command.words);
  return word !== undefined && commandName(word).toLowerCase() === 'false';
}

/**
 * A list of pipelines: a read of the files its top-level reading pipelines
 * read. A pipeline after `||`, inside a compound command or function body,
 * after a shell-terminating command (`exit`, `exec`, `return`, `logout`,
 * `break`, `continue`, `throw`), after `false &&`, or after `&&` in a chain
 * followed by `;` or `||` when a prior step can fail, may not have run and
 * credits no file; its verb still marks its error lines.
 */
function classifyList(commands: SimpleCommand[], flavor: ShellFlavor): ShellClassification {
  const paths = new Set<string>();
  const verbs = new Set<string>();
  const blocks: string[] = [];
  let pendingFn = false;
  let moved = false;
  let terminated = false;

  type CondState = 'INITIAL' | 'ZERO' | 'NONZERO' | 'UNKNOWN';
  let condState: CondState = 'INITIAL';
  let chainFollowed = false;

  for (const [i, command] of commands.entries()) {
    const words = commandWords(command.words);
    let idx = 0;
    while (idx < words.length && COMPOUND_CLOSERS.has(words[idx])) {
      if (blocks.at(-1) !== words[idx]) return SHELL;
      blocks.pop();
      idx++;
      if (blocks.length === 0) pendingFn = false;
    }
    let compound = idx > 0 || blocks.length > 0 || pendingFn;
    while (idx < words.length) {
      const w = words[idx];
      if (blocks.at(-1) === 'esac' && w !== 'esac' && w.endsWith(')')) {
        idx++;
      } else if (COMPOUND_CLAUSES.has(w)) {
        if (!blocks.includes(COMPOUND_CLAUSES.get(w)!)) return SHELL;
        idx++;
      } else if (w === '!' || w === 'time' || w === 'coproc') {
        compound = true;
        idx++;
      } else if (w === 'function') {
        compound = true;
        idx++;
        if (idx < words.length && words[idx] !== '{' && !words[idx].startsWith('(')) idx++;
        if (idx < words.length && words[idx] === '()') idx++;
        if (idx >= words.length) pendingFn = true;
      } else if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(w)) {
        compound = true;
        idx++;
        if (idx >= words.length) pendingFn = true;
      } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w) && words[idx + 1] === '()') {
        compound = true;
        idx += 2;
        if (idx >= words.length) pendingFn = true;
      } else if (w === 'case') {
        blocks.push('esac');
        compound = true;
        idx++;
        while (idx < words.length && words[idx] !== 'in') idx++;
        if (words[idx] === 'in') idx++;
        if (idx < words.length && words[idx] !== 'esac' && words[idx].endsWith(')')) idx++;
      } else if (COMPOUND_OPENERS.has(w)) {
        blocks.push(COMPOUND_OPENERS.get(w)!);
        compound = true;
        idx++;
      } else if (w.startsWith('(')) {
        compound = true;
        pendingFn = false;
        idx++;
      } else {
        break;
      }
    }
    if (blocks.at(-1) === 'esac' && words.at(-1) === 'esac' && idx < words.length) {
      blocks.pop();
      if (blocks.length === 0) pendingFn = false;
    }
    const before = commands[i - 1]?.op;
    if (before !== '|' && before !== '&&') {
      let end = i;
      while (commands[end]?.op === '|' || commands[end]?.op === '&&') end++;
      const afterChain = commands[end]?.op;
      chainFollowed = (afterChain === '||' || afterChain === ';') && end < commands.length - 1;
      if (before !== '||') condState = 'INITIAL';
    }
    if (compound || blocks.length > 0) {
      moved = true;
      condState = 'NONZERO';
      if (commands[i - 1]?.op !== '|' && command.op !== '|') {
        for (let j = idx; j < words.length; j++) {
          const name = commandName(words[j]).toLowerCase();
          if (TERMINATES_SHELL.has(name)) terminated = true;
        }
      }
      if (pendingFn && blocks.length === 0 && idx < words.length) pendingFn = false;
      continue;
    }
    if (before === '|') continue;
    let pipeEnd = i;
    while (commands[pipeEnd]?.op === '|') pipeEnd++;

    let executed = true;
    if (before === '&&') {
      if (condState === 'NONZERO') executed = false;
      else if (condState === 'UNKNOWN' && chainFollowed) executed = false;
    } else if (before === '||') {
      if (condState === 'ZERO') executed = false;
      else if (condState === 'UNKNOWN') executed = false;
    }

    const item = classifySimple(command, false, flavor);
    const skipped = terminated || !executed;
    if (item.category === 'read') {
      item.verbs.forEach((v) => verbs.add(v));
      if (!skipped && before !== '||') {
        item.paths.filter((f) => !moved || isAbsolutePath(f)).forEach((f) => paths.add(f));
      }
    }
    if (!skipped && pipeEnd === i) {
      const [w] = commandWords(command.words);
      const name = w !== undefined ? commandName(w).toLowerCase() : undefined;
      if (name !== undefined && TERMINATES_LIST.has(name)) terminated = true;
    }
    if (executed) {
      const lastCmd = commands[pipeEnd];
      if (pipeEnd === i && isUnconditionalZero(lastCmd)) {
        condState = 'ZERO';
      } else if (pipeEnd === i && isKnownFailure(lastCmd)) {
        condState = 'NONZERO';
      } else {
        condState = 'UNKNOWN';
      }
    }
    const [word] = commandWords(command.words);
    if (!skipped && item.category === 'shell' && word !== undefined && !KEEPS_CWD.has(commandName(word).toLowerCase())) moved = true;
  }
  if (blocks.length > 0 || pendingFn || paths.size === 0) return SHELL;
  return { category: 'read', paths: [...paths], simple: false, verbs: [...verbs] };
}
