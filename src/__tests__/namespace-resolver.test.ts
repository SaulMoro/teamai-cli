import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveNamespacedItems, type NamespaceCandidate } from '../namespace-resolver.js';

function candidate(name: string, namespace: string | null, source = `${namespace ?? 'root'}/${name}`): NamespaceCandidate<string> {
  return { name, source, namespace, value: source };
}

const namespacePool = ['a', 'b', 'c', 'd'];
const namePool = ['x', 'y', 'z'];

/** Files as a reader meets them: each has a place and the names it defines, in file order. */
const files = fc.array(
  fc.record({
    namespace: fc.option(fc.constantFrom(...namespacePool), { nil: null }),
    names: fc.array(fc.constantFrom(...namePool), { maxLength: 3 }),
  }),
  { maxLength: 8 },
);

function candidatesOf(read: { namespace: string | null; names: string[] }[], ids: number[]): NamespaceCandidate<string>[] {
  return ids.flatMap((id) => {
    const file = read[id];
    if (!file) return [];
    const source = `${file.namespace ?? 'root'}/file-${id}`;
    return file.names.map((name, line) => ({ name, source, namespace: file.namespace, value: `${source}:${line}` }));
  });
}

const segment = fc.stringMatching(/^[a-z]{1,6}$/);

describe('resolveNamespacedItems', () => {
  it('does not depend on the order files are read', () => {
    fc.assert(fc.property(
      files.chain((read) => {
        const ids = read.map((_, id) => id);
        return fc.tuple(
          fc.constant(read),
          fc.shuffledSubarray(ids, { minLength: ids.length, maxLength: ids.length }),
          fc.shuffledSubarray(namespacePool),
        );
      }),
      ([read, readOrder, active]) => {
        const inOrder = resolveNamespacedItems(candidatesOf(read, read.map((_, id) => id)), active);
        const shuffled = resolveNamespacedItems(candidatesOf(read, readOrder), active);
        expect(shuffled).toEqual(inOrder);
      },
    ));
  });

  it('lets an active namespace item replace the root item of the same name', () => {
    fc.assert(fc.property(
      fc.uniqueArray(segment, { minLength: 1, maxLength: 4 }).chain((active) => fc.tuple(
        fc.constant(active),
        fc.constantFrom(...active),
        fc.uniqueArray(segment, { minLength: 1, maxLength: 6 }).chain((rootNames) => fc.tuple(
          fc.constant(rootNames),
          fc.subarray(rootNames, { minLength: 1 }),
        )),
      )),
      ([active, namespace, [rootNames, overridden]]) => {
        const result = resolveNamespacedItems([
          ...rootNames.map((name) => candidate(name, null)),
          ...overridden.map((name) => candidate(name, namespace)),
        ], active);

        expect(result.kind).toBe('resolved');
        if (result.kind !== 'resolved') return;
        expect(result.items.map((item) => item.name).sort()).toEqual([...rootNames].sort());
        for (const item of result.items) {
          if (overridden.includes(item.name)) {
            expect(item.namespace).toBe(namespace);
            expect(item.replaces?.source).toBe(`root/${item.name}`);
          } else {
            expect(item.namespace).toBeNull();
            expect(item.replaces).toBeNull();
          }
        }
      },
    ));
  });

  it('reports a name in two active namespaces as a conflict naming both files', () => {
    fc.assert(fc.property(
      fc.uniqueArray(segment, { minLength: 2, maxLength: 5 }).chain((active) => fc.tuple(
        fc.constant(active),
        fc.shuffledSubarray(active, { minLength: 2, maxLength: 2 }),
        fc.boolean(),
        // Other items, one per name and none named "clash", so the only conflict is the one under test.
        fc.uniqueArray(
          fc.record({ name: segment.filter((name) => name !== 'clash'), namespace: fc.option(fc.constantFrom(...active), { nil: null }) }),
          { selector: (item) => item.name, maxLength: 6 },
        ),
      )),
      ([active, [one, other], withRoot, others]) => {
        if (!one || !other) return;
        const result = resolveNamespacedItems([
          ...others.map((item) => candidate(item.name, item.namespace)),
          ...(withRoot ? [candidate('clash', null)] : []),
          candidate('clash', one),
          candidate('clash', other),
        ], active);

        const [earlier, later] = active.indexOf(one) < active.indexOf(other) ? [one, other] : [other, one];
        expect(result).toMatchObject({
          kind: 'conflict',
          reason: 'two-namespaces',
          name: 'clash',
          first: { source: `${earlier}/clash` },
          second: { source: `${later}/clash` },
        });
      },
    ));
  });

  it('drops items in namespaces that are not active', () => {
    const result = resolveNamespacedItems([
      candidate('x', null),
      candidate('x', 'inactive'),
      candidate('y', 'inactive'),
    ], ['active']);

    expect(result).toEqual({
      kind: 'resolved',
      items: [{ ...candidate('x', null), replaces: null }],
    });
  });

  it('reports two items of one name in the same place as a duplicate', () => {
    expect(resolveNamespacedItems([candidate('x', 'a', 'a/x.yaml'), candidate('x', 'a', 'a/x.md')], ['a']))
      .toMatchObject({ kind: 'conflict', reason: 'duplicate', first: { source: 'a/x.md' }, second: { source: 'a/x.yaml' } });
    expect(resolveNamespacedItems([candidate('x', null, 'x.yaml'), candidate('x', null, 'x.md')], []))
      .toMatchObject({ kind: 'conflict', reason: 'duplicate', first: { source: 'x.md' }, second: { source: 'x.yaml' } });
  });

  it('orders items root first, then by active namespace, then by name', () => {
    const result = resolveNamespacedItems([
      candidate('z', 'b'),
      candidate('y', 'a'),
      candidate('x', 'b'),
      candidate('w', null),
    ], ['b', 'a']);

    expect(result.kind === 'resolved' && result.items.map((item) => item.source))
      .toEqual(['root/w', 'b/x', 'b/z', 'a/y']);
  });
});
