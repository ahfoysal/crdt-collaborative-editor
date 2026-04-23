import { describe, it, expect } from 'vitest';
import { RichText, type Op } from './richtext';

function sync(from: RichText, to: RichText, ops: Op[]) {
  for (const op of ops) to.applyRemote(op);
}

describe('RichText CRDT', () => {
  it('replays plain inserts across replicas', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    const ops = a.localInsert(0, 'hello');
    sync(a, b, ops);
    expect(b.toString()).toBe('hello');
  });

  it('format op applies bold to a range', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    sync(a, b, a.localInsert(0, 'hello world'));
    const fmt = a.format(0, 5, { bold: true });
    sync(a, b, fmt);
    expect(b.toRuns()).toEqual([
      { text: 'hello', attrs: { bold: true } },
      { text: ' world', attrs: {} },
    ]);
    expect(a.toRuns()).toEqual(b.toRuns());
  });

  it('concurrent conflicting format ops converge via LWW', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    sync(a, b, a.localInsert(0, 'hi'));

    // Concurrent: A bolds off, B bolds on.
    const aOps = a.format(0, 2, { bold: false });
    const bOps = b.format(0, 2, { bold: true });

    // Cross-apply.
    sync(b, a, bOps);
    sync(a, b, aOps);

    // Both replicas converge to the same state.
    expect(a.toRuns()).toEqual(b.toRuns());
  });

  it('concurrent format on different keys both stick', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    sync(a, b, a.localInsert(0, 'hey'));

    const aOps = a.format(0, 3, { bold: true });
    const bOps = b.format(0, 3, { italic: true });

    sync(b, a, bOps);
    sync(a, b, aOps);

    expect(a.toRuns()).toEqual(b.toRuns());
    expect(a.toRuns()).toEqual([
      { text: 'hey', attrs: { bold: true, italic: true } },
    ]);
  });

  it('format interleaves with inserts and still converges', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    sync(a, b, a.localInsert(0, 'abcd'));

    // A bolds [1,3) → 'bc'
    const aFmt = a.format(1, 3, { bold: true });
    // Concurrently B inserts 'X' at index 2 (between 'b' and 'c')
    const bIns = b.localInsert(2, 'X');

    sync(a, b, aFmt);
    sync(b, a, bIns);

    expect(a.toString()).toBe(b.toString());
    expect(a.toRuns()).toEqual(b.toRuns());
  });

  it('inserts carry attributes snapshot from surrounding formatting', () => {
    const a = new RichText('A');
    a.localInsert(0, 'ab');
    a.format(0, 2, { bold: true });
    // simulate typing at end with bold active
    a.localInsert(2, 'c', { bold: true });
    expect(a.toRuns()).toEqual([{ text: 'abc', attrs: { bold: true } }]);
  });

  it('toggling underline via two sequential format ops ends in last writer state', () => {
    const a = new RichText('A');
    a.localInsert(0, 'xyz');
    a.format(0, 3, { underline: true });
    a.format(0, 3, { underline: false });
    expect(a.toRuns()).toEqual([{ text: 'xyz', attrs: {} }]);
  });

  it('delete removes visible chars but format on tombstones is harmless', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    sync(a, b, a.localInsert(0, 'abc'));
    const fmt = a.format(0, 3, { bold: true });
    const del = a.localDelete(1, 1); // delete 'b'
    sync(a, b, fmt);
    sync(a, b, del);
    expect(b.toString()).toBe('ac');
    expect(b.toRuns()).toEqual([{ text: 'ac', attrs: { bold: true } }]);
  });

  it('format is idempotent on replay', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    sync(a, b, a.localInsert(0, 'hello'));
    const fmt = a.format(0, 5, { italic: true });
    sync(a, b, fmt);
    sync(a, b, fmt); // replay
    expect(b.toRuns()).toEqual([{ text: 'hello', attrs: { italic: true } }]);
  });
});
