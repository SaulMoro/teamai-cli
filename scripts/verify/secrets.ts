/**
 * Keys in a world, by name only: what `--pass` copies from the harness's environment into one command's, and the
 * redaction that keeps every passed value, and every secret-looking value of the harness, out of the terminal and logs/.
 */
import { collectEnvSecrets, redact } from '@teamai/shared/redact';

const VARIABLE_NAME = /^[A-Za-z_]\w*$/;

/** `--pass NAME[,NAME…]` or `--pass=NAME[,NAME…]` at the head of a verb's command, split from the command it precedes. */
export function splitPassOption(argv: readonly string[]) {
  const [first = '', second = ''] = argv;
  const [value, rest] = first === '--pass' ? [second, argv.slice(2)] : first.startsWith('--pass=') ? [first.slice('--pass='.length), argv.slice(1)] : [undefined, [...argv]];

  return { names: value === undefined ? [] : value.split(',').filter(Boolean), argv: rest };
}

/** The named variables of `env`, or the names it has no value for (a name that is no variable's has none). */
export function passedKeys(names: readonly string[], env: NodeJS.ProcessEnv): { ok: true; keys: Map<string, string> } | { ok: false; missing: string[] } {
  const missing = names.filter((name) => !VARIABLE_NAME.test(name) || !env[name]);

  if (missing.length > 0) return { ok: false, missing };

  return { ok: true, keys: new Map(names.map((name) => [name, env[name] ?? ''])) };
}

/** Masks each passed value, whatever its name, and each secret-looking value of the harness's own environment, by name. */
export function worldRedactor({ passed, harnessEnv }: { passed: ReadonlyMap<string, string>; harnessEnv: NodeJS.ProcessEnv }): (text: string) => string {
  const envSecrets = { ...collectEnvSecrets(harnessEnv), ...Object.fromEntries(passed) };

  return (text) => redact(text, { envSecrets, patterns: false });
}

/** Feeds output through `mask` a whole line at a time, so a value split across two chunks is still masked. */
export function lineRedactor(mask: (text: string) => string) {
  let pending = '';

  return {
    push(chunk: string): string {
      const lines = `${pending}${chunk}`;
      const end = lines.lastIndexOf('\n') + 1;
      pending = lines.slice(end);

      return mask(lines.slice(0, end));
    },
    end(): string {
      const rest = pending;
      pending = '';

      return mask(rest);
    },
  };
}
