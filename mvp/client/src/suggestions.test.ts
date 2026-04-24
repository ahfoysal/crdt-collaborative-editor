import { describe, it, expect } from 'vitest';
import { RichText, type InsertOp, type Op as TextOp } from './richtext';
import { SuggestionStore } from './suggestions';

function collectInsertIds(ops: TextOp[]): InsertOp['id'][] {
  return ops.flatMap((op) => (op.type === 'insert' ? [op.id] : []));
}

describe('SuggestionStore', () => {
  it('suggest-insert: accept is a no-op on text; status flips', () => {
    const rt = new RichText('A');
    const seed = rt.localInsert(0, 'hello ');
    const newOps = rt.localInsert(6, 'world');
    const store = new SuggestionStore('A');
    const sug = store.localSuggestInsert(collectInsertIds(newOps), 'user-a');

    expect(rt.toString()).toBe('hello world');
    const { textOps } = store.localAccept(sug.id, 'user-a');
    expect(textOps).toEqual([]);
    expect(store.get(sug.id)!.status).toBe('accepted');
    expect(rt.toString()).toBe('hello world');
    // Silence unused var.
    void seed;
  });

  it('suggest-insert: reject emits deletes that remove the suggested chars', () => {
    const rt = new RichText('A');
    rt.localInsert(0, 'hello ');
    const newOps = rt.localInsert(6, 'world');
    const store = new SuggestionStore('A');
    const sug = store.localSuggestInsert(collectInsertIds(newOps), 'user-a');

    const { textOps } = store.localReject(sug.id, 'user-a');
    for (const op of textOps) rt.applyRemote(op);
    expect(rt.toString()).toBe('hello ');
    expect(store.get(sug.id)!.status).toBe('rejected');
  });

  it('suggest-delete: accept emits real deletes; reject leaves text alone', () => {
    const rtA = new RichText('A');
    const rtB = new RichText('B');
    const seed = rtA.localInsert(0, 'abcdef');
    for (const op of seed) rtB.applyRemote(op);

    const storeA = new SuggestionStore('A');
    const storeB = new SuggestionStore('B');
    // Suggest deleting 'cd' (ids at visible indices 2 and 3).
    const targetIds = [seed[2] as InsertOp, seed[3] as InsertOp].map((o) => o.id);
    const sug = storeA.localSuggestDelete(targetIds, 'user-a');
    storeB.applyRemote(sug);

    // Still pending — text unchanged.
    expect(rtA.toString()).toBe('abcdef');
    expect(rtB.toString()).toBe('abcdef');

    const { status, textOps } = storeA.localAccept(sug.id, 'user-a');
    // apply text ops everywhere.
    for (const op of textOps) { rtA.applyRemote(op); rtB.applyRemote(op); }
    storeB.applyRemote(status);
    expect(rtA.toString()).toBe('abef');
    expect(rtB.toString()).toBe('abef');
    expect(storeA.get(sug.id)!.status).toBe('accepted');
    expect(storeB.get(sug.id)!.status).toBe('accepted');
  });

  it('suggest-delete reject: no text change, status rejected', () => {
    const rt = new RichText('A');
    const seed = rt.localInsert(0, 'abcdef');
    const store = new SuggestionStore('A');
    const targetIds = [seed[2] as InsertOp, seed[3] as InsertOp].map((o) => o.id);
    const sug = store.localSuggestDelete(targetIds, 'user-a');

    const { textOps } = store.localReject(sug.id, 'user-a');
    expect(textOps).toEqual([]);
    expect(rt.toString()).toBe('abcdef');
    expect(store.get(sug.id)!.status).toBe('rejected');
  });

  it('concurrent accept/reject resolves by LWW', () => {
    const rt = new RichText('A');
    const seed = rt.localInsert(0, 'xy');
    const a = new SuggestionStore('A');
    const b = new SuggestionStore('B');
    const targetIds = [seed[0] as InsertOp].map((o) => o.id);
    const sug = a.localSuggestDelete(targetIds, 'user-a');
    b.applyRemote(sug);

    const accept = a.localAccept(sug.id, 'user-a');
    const reject = b.localReject(sug.id, 'user-b');
    // Cross-apply status ops.
    a.applyRemote(reject.status);
    b.applyRemote(accept.status);

    // Both replicas must agree.
    expect(a.get(sug.id)!.status).toBe(b.get(sug.id)!.status);
  });

  it('remote replay is idempotent', () => {
    const rt = new RichText('A');
    const seed = rt.localInsert(0, 'xy');
    const a = new SuggestionStore('A');
    const b = new SuggestionStore('B');
    const sug = a.localSuggestInsert([(seed[0] as InsertOp).id], 'user-a');
    expect(b.applyRemote(sug)).toBe(true);
    expect(b.applyRemote(sug)).toBe(false);
    const { status } = a.localAccept(sug.id, 'user-a');
    expect(b.applyRemote(status)).toBe(true);
    expect(b.applyRemote(status)).toBe(false);
  });
});
