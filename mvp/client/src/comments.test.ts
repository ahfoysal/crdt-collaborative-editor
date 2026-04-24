import { describe, it, expect } from 'vitest';
import { RichText, type InsertOp } from './richtext';
import { CommentStore } from './comments';

function lastInsertId(ops: any[]): InsertOp['id'] {
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].type === 'insert') return ops[i].id;
  throw new Error('no insert');
}

function firstInsertId(ops: any[]): InsertOp['id'] {
  for (const op of ops) if (op.type === 'insert') return op.id;
  throw new Error('no insert');
}

describe('CommentStore', () => {
  it('creates a thread anchored to a range', () => {
    const rt = new RichText('A');
    const ops = rt.localInsert(0, 'hello world');
    const startId = firstInsertId(ops.slice(0, 1));          // 'h'
    const endId = ops[4].type === 'insert' ? ops[4].id : null as any; // 'o' at index 4
    const store = new CommentStore('A');
    const thread = store.localCreateThread(startId, endId, 'user-a');
    expect(thread.type).toBe('thread:create');
    const range = store.resolveRange(rt, store.getThread(thread.id)!);
    expect(range).toEqual({ start: 0, end: 5 });
  });

  it('anchor survives concurrent edits around it', () => {
    const a = new RichText('A');
    const b = new RichText('B');
    const seed = a.localInsert(0, 'hello world');
    for (const op of seed) b.applyRemote(op);

    // 'world' = chars at visible indices 6..10 inclusive. 'w' is the 7th insert.
    const startId = seed[6].type === 'insert' ? seed[6].id : null as any; // 'w'
    const endId = seed[10].type === 'insert' ? seed[10].id : null as any;  // 'd'

    const store = new CommentStore('A');
    const t = store.localCreateThread(startId, endId, 'user-a');

    // Concurrently: A inserts at beginning, B inserts in the middle.
    const aIns = a.localInsert(0, 'XY');        // now "XYhello world"
    const bIns = b.localInsert(3, 'ZZ');        // now "helZZlo world"
    for (const op of aIns) b.applyRemote(op);
    for (const op of bIns) a.applyRemote(op);
    expect(a.toString()).toBe(b.toString());

    // The anchor still resolves to exactly "world" in the merged doc.
    const range = store.resolveRange(a, store.getThread(t.id)!);
    expect(range).not.toBeNull();
    const text = a.toString();
    expect(text.slice(range!.start, range!.end)).toBe('world');
  });

  it('anchor collapses but survives when the range is deleted', () => {
    const rt = new RichText('A');
    const ops = rt.localInsert(0, 'abcdef');
    const startId = ops[2].type === 'insert' ? ops[2].id : null as any; // 'c'
    const endId = ops[3].type === 'insert' ? ops[3].id : null as any;   // 'd'
    const store = new CommentStore('A');
    const t = store.localCreateThread(startId, endId, 'u');

    // Delete 'cd'.
    rt.localDelete(2, 2);
    const range = store.resolveRange(rt, store.getThread(t.id)!);
    expect(range).not.toBeNull();
    expect(range!.end).toBe(range!.start);      // collapsed
    expect(rt.toString()).toBe('abef');
    expect(range!.start).toBe(2);
  });

  it('multi-author threading: two users add comments that converge', () => {
    const rt = new RichText('A');
    const ops = rt.localInsert(0, 'hello');
    const sid = ops[0].type === 'insert' ? ops[0].id : null as any;
    const eid = ops[4].type === 'insert' ? ops[4].id : null as any;

    const a = new CommentStore('A');
    const b = new CommentStore('B');
    const create = a.localCreateThread(sid, eid, 'user-a');
    b.applyRemote(create);

    const c1 = a.localAddComment(create.id, 'user-a', 'first');
    const c2 = b.localAddComment(create.id, 'user-b', 'second');
    a.applyRemote(c2);
    b.applyRemote(c1);

    const ta = a.getThread(create.id)!;
    const tb = b.getThread(create.id)!;
    expect(ta.comments.length).toBe(2);
    expect(tb.comments.length).toBe(2);
    // Same order on both replicas.
    expect(ta.comments.map((c) => c.authorId)).toEqual(tb.comments.map((c) => c.authorId));
  });

  it('resolve is LWW across concurrent toggles', () => {
    const rt = new RichText('A');
    const ops = rt.localInsert(0, 'xy');
    const sid = ops[0].type === 'insert' ? ops[0].id : null as any;
    const eid = ops[1].type === 'insert' ? ops[1].id : null as any;
    const a = new CommentStore('A');
    const b = new CommentStore('B');
    const t = a.localCreateThread(sid, eid, 'u');
    b.applyRemote(t);

    const r1 = a.localSetResolved(t.id, true, 'u-a');
    const r2 = b.localSetResolved(t.id, false, 'u-b');
    // cross-apply
    a.applyRemote(r2);
    b.applyRemote(r1);
    expect(a.getThread(t.id)!.resolved).toBe(b.getThread(t.id)!.resolved);
  });

  it('ignores duplicate remote ops', () => {
    const rt = new RichText('A');
    const ops = rt.localInsert(0, 'xy');
    const sid = ops[0].type === 'insert' ? ops[0].id : null as any;
    const eid = ops[1].type === 'insert' ? ops[1].id : null as any;
    const a = new CommentStore('A');
    const b = new CommentStore('B');
    const t = a.localCreateThread(sid, eid, 'u');
    const c = a.localAddComment(t.id, 'u', 'hi');
    expect(b.applyRemote(t)).toBe(true);
    expect(b.applyRemote(t)).toBe(false);
    expect(b.applyRemote(c)).toBe(true);
    expect(b.applyRemote(c)).toBe(false);
    expect(b.getThread(t.id)!.comments.length).toBe(1);
  });
});
