import { describe, expect, expectTypeOf, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { isJsonObject, type JsonObject } from './json.js';

describe('isJsonObject', () => {
  it('takes what JSON and YAML parse an object to, null-prototype documents and YAML\'s .inf and .nan among them', () => {
    expect(isJsonObject(JSON.parse('{"a":[1,"x",true,null,{"b":{}}],"__proto__":{"c":1}}'))).toBe(true);
    expect(isJsonObject(parseYaml('limit: .inf\nratio: .nan\nnested: { list: [1, two] }\n'))).toBe(true);
    expect(isJsonObject(Object.assign(Object.create(null), { a: 1 }))).toBe(true);
  });

  it('refuses arrays, primitives, null and undefined', () => {
    for (const value of [[], 'x', 1, true, null, undefined]) expect(isJsonObject(value)).toBe(false);
  });

  it('refuses an object JSON cannot write, at the top or anywhere below it, and one that holds itself', () => {
    for (const value of [new Date(), new Map(), () => {}, new (class Point { x = 1; })()]) expect(isJsonObject(value)).toBe(false);

    expect(isJsonObject({ at: new Date() })).toBe(false);
    expect(isJsonObject({ list: [1, undefined] })).toBe(false);
    expect(isJsonObject({ nested: { run: () => {} } })).toBe(false);
    expect(isJsonObject({ id: Symbol('x') })).toBe(false);
    expect(isJsonObject({ count: 1n })).toBe(false);
    // A YAML alias inside its own anchor parses to an object that holds itself, which no JSON text writes.
    expect(isJsonObject(parseYaml('loop: &self\n  again: *self\n'))).toBe(false);
  });

  it('narrows unparsed input, so data from a file needs no annotation first', () => {
    const read: unknown = JSON.parse('{"name":"x"}');

    if (isJsonObject(read)) expectTypeOf(read).toEqualTypeOf<JsonObject>();
  });
});
