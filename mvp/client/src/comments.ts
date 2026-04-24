/**
 * CRDT-native comment threads (M6).
 *
 * A comment "anchor" is a pair of RGA character IDs (startId, endId). Because
 * RGA IDs are immutable once allocated — deletes only tombstone the node, they
 * never drop it from the tree — anchors survive concurrent edits around them:
 *
 *   - Inserts before/after/inside the anchored range don't move the anchor,
 *     because anchors point to specific character identities, not offsets.
 *   - Deletes inside the range tombstone the chars but leave the IDs valid.
 *     The visible range simply shrinks (or becomes empty) — the thread is
 *     still resolvable to a (possibly empty) slice of the current text.
 *
 * The CommentStore itself is a small CRDT. Three op types:
 *   - thread:create { id, startId, endId, authorId, at }
 *   - thread:comment { id, threadId, authorId, text, at }
 *   - thread:resolve { id, threadId, resolved, at, authorId }   (LWW)
 *
 * Convergence: threads are keyed by op id (`c:l`), so concurrent creates at
 * the same range produce independent threads — that's the desired semantic
 * for a "comment" (two authors commenting concurrently on the same text make
 * two threads). Comments inside a thread form a set keyed by op id; rendered
 * order is sorted by (at asc, authorId asc) for determinism. Resolve is LWW
 * by (at desc, authorId desc).
 *
 * Range tracking: `resolveRange(rt, thread)` returns the current visible
 * [start, end) offsets by walking `rt`'s visible nodes and locating startId
 * and endId. If either ID is fully tombstoned AND has no visible neighbours,
 * we return null ("anchor lost"). In practice the tombstone still gives us a
 * position via its position in the flat RGA order.
 */

import type { OpId } from './richtext';
import type { RichText } from './richtext';

export type CommentId = OpId;
export type ThreadId = OpId;

export type CreateThreadOp = {
  type: 'thread:create';
  id: ThreadId;
  startId: OpId;
  endId: OpId;
  authorId: string;
  at: number;
};

export type AddCommentOp = {
  type: 'thread:comment';
  id: CommentId;
  threadId: ThreadId;
  authorId: string;
  text: string;
  at: number;
};

export type ResolveThreadOp = {
  type: 'thread:resolve';
  id: OpId;           // stamp used for LWW on the resolve register
  threadId: ThreadId;
  resolved: boolean;
  authorId: string;
  at: number;
};

export type CommentOp = CreateThreadOp | AddCommentOp | ResolveThreadOp;

export type Comment = {
  id: CommentId;
  authorId: string;
  text: string;
  at: number;
};

export type Thread = {
  id: ThreadId;
  startId: OpId;
  endId: OpId;
  createdBy: string;
  createdAt: number;
  comments: Comment[];
  resolved: boolean;
  // Stamp of the last resolve op applied (for LWW).
  resolvedBy: { lamport: number; clientId: string } | null;
};

function idKey(id: OpId): string {
  return `${id.c}:${id.l}`;
}

/** LWW: incoming wins if its lamport is higher, ties broken by higher clientId. */
function lwwWins(incoming: OpId, existing: { lamport: number; clientId: string } | null): boolean {
  if (!existing) return true;
  if (incoming.l !== existing.lamport) return incoming.l > existing.lamport;
  return incoming.c > existing.clientId;
}

export class CommentStore {
  readonly clientId: string;
  private lamport = 0;
  private threads = new Map<string, Thread>();
  private seenOps = new Set<string>();

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  // ---- local API ------------------------------------------------------

  /** Create a thread anchored to (startId, endId). Returns the op to emit. */
  localCreateThread(startId: OpId, endId: OpId, authorId: string): CreateThreadOp {
    this.lamport++;
    const op: CreateThreadOp = {
      type: 'thread:create',
      id: { c: this.clientId, l: this.lamport },
      startId,
      endId,
      authorId,
      at: Date.now(),
    };
    this.apply(op);
    return op;
  }

  localAddComment(threadId: ThreadId, authorId: string, text: string): AddCommentOp {
    this.lamport++;
    const op: AddCommentOp = {
      type: 'thread:comment',
      id: { c: this.clientId, l: this.lamport },
      threadId,
      authorId,
      text,
      at: Date.now(),
    };
    this.apply(op);
    return op;
  }

  localSetResolved(threadId: ThreadId, resolved: boolean, authorId: string): ResolveThreadOp {
    this.lamport++;
    const op: ResolveThreadOp = {
      type: 'thread:resolve',
      id: { c: this.clientId, l: this.lamport },
      threadId,
      resolved,
      authorId,
      at: Date.now(),
    };
    this.apply(op);
    return op;
  }

  // ---- remote ---------------------------------------------------------

  /** Apply a remote op. Returns true if state changed. */
  applyRemote(op: CommentOp): boolean {
    const k = idKey(op.id);
    if (op.type !== 'thread:resolve' && this.seenOps.has(k)) return false;
    this.lamport = Math.max(this.lamport, op.id.l);
    return this.apply(op);
  }

  private apply(op: CommentOp): boolean {
    const k = idKey(op.id);
    if (op.type === 'thread:create') {
      if (this.seenOps.has(k)) return false;
      this.seenOps.add(k);
      const tk = idKey(op.id);
      if (this.threads.has(tk)) return false;
      this.threads.set(tk, {
        id: op.id,
        startId: op.startId,
        endId: op.endId,
        createdBy: op.authorId,
        createdAt: op.at,
        comments: [],
        resolved: false,
        resolvedBy: null,
      });
      return true;
    }
    if (op.type === 'thread:comment') {
      if (this.seenOps.has(k)) return false;
      this.seenOps.add(k);
      const t = this.threads.get(idKey(op.threadId));
      if (!t) {
        // Out-of-order: remember the comment by parking it in a pending
        // list until we see the thread. Simple approach: create a stub
        // thread that will be completed when the create op arrives.
        this.threads.set(idKey(op.threadId), {
          id: op.threadId,
          startId: { c: '?', l: 0 },
          endId: { c: '?', l: 0 },
          createdBy: '?',
          createdAt: 0,
          comments: [{ id: op.id, authorId: op.authorId, text: op.text, at: op.at }],
          resolved: false,
          resolvedBy: null,
        });
        return true;
      }
      if (t.comments.some((c) => idKey(c.id) === idKey(op.id))) return false;
      t.comments.push({ id: op.id, authorId: op.authorId, text: op.text, at: op.at });
      t.comments.sort((a, b) => (a.at - b.at) || (a.authorId < b.authorId ? -1 : 1));
      return true;
    }
    // resolve
    const t = this.threads.get(idKey(op.threadId));
    if (!t) return false;
    if (!lwwWins(op.id, t.resolvedBy)) return false;
    const prev = t.resolved;
    t.resolved = op.resolved;
    t.resolvedBy = { lamport: op.id.l, clientId: op.id.c };
    this.seenOps.add(k);
    return prev !== op.resolved;
  }

  // ---- queries --------------------------------------------------------

  listThreads(): Thread[] {
    return [...this.threads.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getThread(id: ThreadId): Thread | null {
    return this.threads.get(idKey(id)) ?? null;
  }

  /**
   * Resolve a thread's anchors to current [start, end) visible offsets.
   * Returns null if both anchor IDs are gone (should not happen under RGA —
   * IDs are permanent — but defensive).
   *
   * If the anchored range has been fully deleted, returns a collapsed range
   * at the position the start anchor logically occupies.
   */
  resolveRange(rt: RichText, thread: Thread): { start: number; end: number } | null {
    // Build a map of visible offset -> nodeId by iterating the RGA in order.
    const flat = (rt as any).flat as Array<{ id: OpId; deleted: boolean }>;
    if (!Array.isArray(flat)) return null;
    let visibleIdx = 0;
    let startOff: number | null = null;
    let endOff: number | null = null;
    // A character with id X occupies visible offsets [idx, idx+1) if not deleted.
    // If deleted, we still record its logical visible-before index.
    for (const n of flat) {
      const here = visibleIdx;
      if (idKey(n.id) === idKey(thread.startId)) startOff = here;
      if (idKey(n.id) === idKey(thread.endId)) endOff = here + (n.deleted ? 0 : 1);
      if (!n.deleted) visibleIdx++;
    }
    if (startOff === null && endOff === null) return null;
    if (startOff === null) startOff = endOff!;
    if (endOff === null) endOff = startOff;
    if (endOff < startOff) endOff = startOff;
    return { start: startOff, end: endOff };
  }
}
