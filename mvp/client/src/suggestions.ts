/**
 * "Track changes" suggestion mode (M6).
 *
 * A suggestion is a tentative edit that other collaborators can accept or
 * reject. We model suggestions as metadata alongside the underlying CRDT:
 *
 *   - Suggested insertion: the new characters are inserted into the RGA as
 *     normal (so they converge and everyone sees them), but the suggestion
 *     store records the range of inserted IDs under a Suggestion record.
 *     The UI renders those characters with a visual treatment (green
 *     underline, author colour). Accept ⇒ status flips to "accepted" and
 *     the visual treatment drops. Reject ⇒ we emit delete ops for each id.
 *
 *   - Suggested deletion: the target characters are NOT deleted from the
 *     RGA yet. The suggestion store records the ids; the UI renders them
 *     struck-through. Accept ⇒ emit real delete ops. Reject ⇒ mark the
 *     suggestion rejected; nothing else to do.
 *
 * Why not a format op? A format op could carry the "suggested" marker but
 * would need reverse logic for accept/reject. Keeping suggestions in their
 * own CRDT store keeps the primary text CRDT clean (no new attribute types)
 * and lets us attribute every suggestion to its author even if the author
 * has no other presence in the doc.
 *
 * Convergence: suggestion ops are keyed by opId. Status (pending /
 * accepted / rejected) is a LWW register per suggestion. Two users cannot
 * "both accept" meaningfully — the last writer wins, which matches user
 * expectations ("I accepted it, then Bob un-did and rejected it").
 *
 * Resolve effects: `accept(sid)` returns the text-CRDT ops that must be
 * emitted to realise the suggestion (the real deletes for a suggested
 * deletion). `reject(sid)` returns the text-CRDT ops to undo a suggested
 * insertion. The caller is responsible for emitting those ops via the
 * normal sync path so peers converge.
 */

import type { OpId, Op as TextOp, DeleteOp } from './richtext';

export type SuggestionId = OpId;

export type SuggestInsertOp = {
  type: 'suggest:insert';
  id: SuggestionId;
  ids: OpId[];         // ids of the chars that were inserted
  authorId: string;
  at: number;
};

export type SuggestDeleteOp = {
  type: 'suggest:delete';
  id: SuggestionId;
  ids: OpId[];         // target char ids
  authorId: string;
  at: number;
};

export type SuggestStatusOp = {
  type: 'suggest:status';
  id: OpId;            // stamp for LWW
  suggestionId: SuggestionId;
  status: 'accepted' | 'rejected';
  authorId: string;
  at: number;
};

export type SuggestionOp = SuggestInsertOp | SuggestDeleteOp | SuggestStatusOp;

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export type Suggestion = {
  id: SuggestionId;
  kind: 'insert' | 'delete';
  ids: OpId[];
  authorId: string;
  at: number;
  status: SuggestionStatus;
  statusStamp: { lamport: number; clientId: string } | null;
};

function idKey(id: OpId): string {
  return `${id.c}:${id.l}`;
}

function lwwWins(incoming: OpId, existing: { lamport: number; clientId: string } | null): boolean {
  if (!existing) return true;
  if (incoming.l !== existing.lamport) return incoming.l > existing.lamport;
  return incoming.c > existing.clientId;
}

export class SuggestionStore {
  readonly clientId: string;
  private lamport = 0;
  private suggestions = new Map<string, Suggestion>();
  /** Reverse index: char-id -> suggestion ids that reference it. */
  private byCharId = new Map<string, Set<string>>();

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  // ---- local API ------------------------------------------------------

  /**
   * Record a suggested insertion whose underlying insert ops have already
   * been applied to the text CRDT.
   */
  localSuggestInsert(ids: OpId[], authorId: string): SuggestInsertOp {
    this.lamport++;
    const op: SuggestInsertOp = {
      type: 'suggest:insert',
      id: { c: this.clientId, l: this.lamport },
      ids,
      authorId,
      at: Date.now(),
    };
    this.apply(op);
    return op;
  }

  localSuggestDelete(ids: OpId[], authorId: string): SuggestDeleteOp {
    this.lamport++;
    const op: SuggestDeleteOp = {
      type: 'suggest:delete',
      id: { c: this.clientId, l: this.lamport },
      ids,
      authorId,
      at: Date.now(),
    };
    this.apply(op);
    return op;
  }

  /**
   * Accept a suggestion. Returns text-CRDT ops that must be emitted to
   * realise it (empty array for insert suggestions; delete ops for delete
   * suggestions). The status op itself is returned so the caller can
   * broadcast it to peers.
   */
  localAccept(sid: SuggestionId, authorId: string): { status: SuggestStatusOp; textOps: TextOp[] } {
    const sug = this.suggestions.get(idKey(sid));
    if (!sug) throw new Error('unknown suggestion');
    this.lamport++;
    const status: SuggestStatusOp = {
      type: 'suggest:status',
      id: { c: this.clientId, l: this.lamport },
      suggestionId: sid,
      status: 'accepted',
      authorId,
      at: Date.now(),
    };
    const textOps: TextOp[] = [];
    if (sug.kind === 'delete' && sug.status === 'pending') {
      for (const tid of sug.ids) textOps.push({ type: 'delete', id: tid } as DeleteOp);
    }
    this.apply(status);
    return { status, textOps };
  }

  /**
   * Reject a suggestion. Returns text-CRDT ops that undo the suggestion's
   * effect on the document (delete the suggested-inserted chars) plus the
   * status op for peers.
   */
  localReject(sid: SuggestionId, authorId: string): { status: SuggestStatusOp; textOps: TextOp[] } {
    const sug = this.suggestions.get(idKey(sid));
    if (!sug) throw new Error('unknown suggestion');
    this.lamport++;
    const status: SuggestStatusOp = {
      type: 'suggest:status',
      id: { c: this.clientId, l: this.lamport },
      suggestionId: sid,
      status: 'rejected',
      authorId,
      at: Date.now(),
    };
    const textOps: TextOp[] = [];
    if (sug.kind === 'insert' && sug.status === 'pending') {
      for (const tid of sug.ids) textOps.push({ type: 'delete', id: tid } as DeleteOp);
    }
    this.apply(status);
    return { status, textOps };
  }

  // ---- remote ---------------------------------------------------------

  applyRemote(op: SuggestionOp): boolean {
    this.lamport = Math.max(this.lamport, op.id.l);
    return this.apply(op);
  }

  private apply(op: SuggestionOp): boolean {
    if (op.type === 'suggest:insert' || op.type === 'suggest:delete') {
      const k = idKey(op.id);
      if (this.suggestions.has(k)) return false;
      const kind = op.type === 'suggest:insert' ? 'insert' : 'delete';
      const sug: Suggestion = {
        id: op.id,
        kind,
        ids: op.ids,
        authorId: op.authorId,
        at: op.at,
        status: 'pending',
        statusStamp: null,
      };
      this.suggestions.set(k, sug);
      for (const cid of op.ids) {
        const ck = idKey(cid);
        let set = this.byCharId.get(ck);
        if (!set) { set = new Set(); this.byCharId.set(ck, set); }
        set.add(k);
      }
      return true;
    }
    // status
    const sug = this.suggestions.get(idKey(op.suggestionId));
    if (!sug) return false;
    if (!lwwWins(op.id, sug.statusStamp)) return false;
    const prev = sug.status;
    sug.status = op.status;
    sug.statusStamp = { lamport: op.id.l, clientId: op.id.c };
    return prev !== op.status;
  }

  // ---- queries --------------------------------------------------------

  list(): Suggestion[] {
    return [...this.suggestions.values()].sort((a, b) => a.at - b.at);
  }

  get(id: SuggestionId): Suggestion | null {
    return this.suggestions.get(idKey(id)) ?? null;
  }

  /** All pending suggestions that reference this char id. */
  forCharId(cid: OpId): Suggestion[] {
    const set = this.byCharId.get(idKey(cid));
    if (!set) return [];
    const out: Suggestion[] = [];
    for (const sk of set) {
      const s = this.suggestions.get(sk);
      if (s && s.status === 'pending') out.push(s);
    }
    return out;
  }
}
