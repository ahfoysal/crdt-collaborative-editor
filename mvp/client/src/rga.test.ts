import { describe, it, expect } from 'vitest';
import { RGA } from './rga';

describe('RGA (convergence sanity)', () => {
  it('replays local ops on a fresh replica and matches', () => {
    const a = new RGA('A');
    const ops = a.localInsert(0, 'hello');
    const b = new RGA('B');
    for (const op of ops) b.applyRemote(op);
    expect(b.toString()).toBe('hello');
  });

  it('converges under concurrent inserts at the same anchor', () => {
    const a = new RGA('A');
    const b = new RGA('B');
    const seed = a.localInsert(0, 'X');
    for (const op of seed) b.applyRemote(op);
    const aOps = a.localInsert(1, 'a');
    const bOps = b.localInsert(1, 'b');
    for (const op of bOps) a.applyRemote(op);
    for (const op of aOps) b.applyRemote(op);
    expect(a.toString()).toBe(b.toString());
  });

  it('delete is idempotent', () => {
    const a = new RGA('A');
    const ins = a.localInsert(0, 'hi');
    const del = a.localDelete(0, 1);
    const b = new RGA('B');
    for (const op of ins) b.applyRemote(op);
    for (const op of del) b.applyRemote(op);
    for (const op of del) b.applyRemote(op); // replay
    expect(b.toString()).toBe('i');
    expect(a.toString()).toBe(b.toString());
  });
});
