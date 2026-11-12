import { describe, expect, it } from 'vitest';
import { lineRedactor, passedKeys, splitPassOption, worldRedactor } from './secrets.js';

const TOKEN = 'tok-0123456789abcdef';

describe('--pass', () => {
  it('takes the names given right after the run id, in one word or two, and leaves the command alone', () => {
    expect(splitPassOption(['--pass', 'A_TOKEN,B', 'teamai', '--pass', 'x'])).toEqual({ names: ['A_TOKEN', 'B'], argv: ['teamai', '--pass', 'x'] });
    expect(splitPassOption(['--pass=A_TOKEN', 'git', 'status'])).toEqual({ names: ['A_TOKEN'], argv: ['git', 'status'] });
    expect(splitPassOption(['git', 'status'])).toEqual({ names: [], argv: ['git', 'status'] });
  });

  it('copies each named variable from the harness, and names the ones it does not have', () => {
    expect(passedKeys(['A_TOKEN', 'PLAIN'], { A_TOKEN: TOKEN, PLAIN: 'x', OTHER: 'y' })).toEqual({ ok: true, keys: new Map([['A_TOKEN', TOKEN], ['PLAIN', 'x']]) });
    expect(passedKeys(['A_TOKEN', 'GONE', 'EMPTY'], { A_TOKEN: TOKEN, EMPTY: '' })).toEqual({ ok: false, missing: ['GONE', 'EMPTY'] });
  });

  it('refuses a name that is not a variable name', () => {
    expect(passedKeys(['A-B'], { 'A-B': 'x' })).toEqual({ ok: false, missing: ['A-B'] });
  });
});

describe("a world's redaction", () => {
  it('masks every passed value, whatever its name, and every secret-looking value of the harness, by name', () => {
    const redact = worldRedactor({ passed: new Map([['GATEWAY_URL', 'https://gw.internal.example']]), harnessEnv: { ANTHROPIC_AUTH_TOKEN: TOKEN, HOME: '/Users/me' } });

    expect(redact(`calling https://gw.internal.example with ${TOKEN} from /Users/me`)).toBe('calling <REDACTED:GATEWAY_URL> with <REDACTED:ANTHROPIC_AUTH_TOKEN> from /Users/me');
  });

  it('masks a value that arrives split across two chunks, line by line', () => {
    const lines = lineRedactor(worldRedactor({ passed: new Map([['A_TOKEN', TOKEN]]), harnessEnv: {} }));

    expect(`${lines.push(`one ${TOKEN.slice(0, 7)}`)}${lines.push(`${TOKEN.slice(7)} two\nthree `)}${lines.push(TOKEN)}${lines.end()}`).toBe('one <REDACTED:A_TOKEN> two\nthree <REDACTED:A_TOKEN>');
  });
});
