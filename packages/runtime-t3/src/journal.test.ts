import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpId } from '@teamai/runtime-protocol';
import { journal, type PlaceRecord } from './journal.js';

const PLACE: PlaceRecord = { kind: 'confined', handle: 't3-r0123abcd-a0123abcd', run: 'r0123abcd', attempt: 'a0123abcd', ops: {}, threads: {}, launches: {} };
const FIRST = 'op-00000001' as OpId;
const SECOND = 'op-00000002' as OpId;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-journal-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the T3 journal', () => {
  it('keeps the ends two runtime processes write for different operations of one place, each from what it read before', () => {
    const recovering = journal(dir);
    const launching = journal(dir);
    recovering.open(PLACE);
    expect(recovering.read(PLACE.handle)).toMatchObject({ kind: 'found' });
    expect(launching.read(PLACE.handle)).toMatchObject({ kind: 'found' });

    recovering.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'cancelled' } }));
    launching.update({ handle: PLACE.handle, op: SECOND }, () => ({ state: { op: SECOND, state: 'exited', code: 0, stdout: '' } }));

    expect(journal(dir).read(PLACE.handle)).toEqual({
      kind: 'found',
      place: { ...PLACE, ops: { [FIRST]: { op: FIRST, state: 'cancelled' }, [SECOND]: { op: SECOND, state: 'exited', code: 0, stdout: '' } } },
    });
  });

  it('reads a place that still holds its operations in its own record as unreadable, naming the file', () => {
    const places = journal(dir);
    fs.writeFileSync(places.file(PLACE.handle), JSON.stringify({ ...PLACE, ops: { [FIRST]: { op: FIRST, state: 'running' } } }));

    expect(places.read(PLACE.handle)).toEqual({ kind: 'unreadable', file: places.file(PLACE.handle), why: expect.stringContaining('ops') });
    expect(places.placeOf(FIRST)).toMatchObject({ kind: 'unreadable' });
  });

  it('forgets a place and every operation of it once removed', () => {
    const places = journal(dir);
    places.open(PLACE);
    places.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'running' } }));

    places.remove(PLACE.handle);

    expect(places.read(PLACE.handle)).toEqual({ kind: 'missing' });
    expect(places.placeOf(FIRST)).toEqual({ kind: 'missing' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
