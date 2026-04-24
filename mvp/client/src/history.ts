/**
 * Client-side history helpers (M5).
 *
 * The server owns the snapshot list; the client only needs a thin RPC layer
 * to:
 *   1. list snapshots
 *   2. fetch the ops at a chosen snapshot (to preview the old doc)
 *   3. request a restore (which rebuilds a CRDT from the snapshot ops and
 *      emits local ops so the *live* doc converges to the snapshot state)
 *
 * Request/response is correlated via a small `reqId` — the server doesn't
 * thread request IDs, so we queue pending callbacks per message type and
 * resolve them in FIFO order (history is request/response, one-in-flight in
 * practice).
 *
 * Restore semantics: we treat a snapshot as a *target string*. Rather than
 * replace the whole doc with snapshot ops (which would confuse other clients
 * who never saw those ops in the live branch), we compute a diff against the
 * current visible text and emit a delete-range + insert-run pair. This keeps
 * restore on the same op-stream rails as normal typing.
 */
import type { Op } from './rga';
import { RGA } from './rga';

export type Snapshot = {
  id: string;
  seq: number;
  t: number;
  label?: string;
};

export type LogEntry = { seq: number; op: Op };

type Pending = { resolve: (v: any) => void; reject: (err: any) => void };

export class HistoryClient {
  private ws: WebSocket | null = null;
  private pendingList: Pending[] = [];
  private pendingGet = new Map<string, Pending>();
  private pendingSnap: Pending[] = [];

  constructor() {}

  attach(ws: WebSocket): void {
    this.ws = ws;
  }

  /** Feed incoming messages here from the sync layer. */
  handleMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'history:list') {
      const p = this.pendingList.shift();
      if (p) p.resolve(msg.snapshots as Snapshot[]);
      return true;
    }
    if (msg.type === 'history:get' && typeof msg.id === 'string') {
      const p = this.pendingGet.get(msg.id);
      if (p) {
        this.pendingGet.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.ops as LogEntry[]);
      }
      return true;
    }
    if (msg.type === 'history:snapshot') {
      const p = this.pendingSnap.shift();
      if (p) p.resolve(msg.snapshot as Snapshot | null);
      return true;
    }
    return false;
  }

  list(): Promise<Snapshot[]> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      this.pendingList.push({ resolve, reject });
      this.ws.send(JSON.stringify({ type: 'history:list' }));
    });
  }

  fetch(id: string): Promise<LogEntry[]> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      this.pendingGet.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'history:get', id }));
    });
  }

  snapshotNow(label?: string): Promise<Snapshot | null> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      this.pendingSnap.push({ resolve, reject });
      this.ws.send(JSON.stringify({ type: 'history:snapshot', label }));
    });
  }
}

/**
 * Rebuild a throwaway RGA from a snapshot's op log and return its visible
 * text. Used by the history UI to preview a prior version without disturbing
 * the live CRDT.
 */
export function reconstructText(entries: LogEntry[]): string {
  // Any clientId works here; we're never going to emit ops from this RGA.
  const rga = new RGA('__history_preview__');
  for (const e of entries) rga.applyRemote(e.op);
  return rga.toString();
}

/**
 * Compute a (start, deleteCount, insertText) triple that, when applied to
 * `current`, produces `target`. Finds the longest common prefix/suffix so the
 * edit is minimal — one contiguous replacement range. Good enough for
 * version-restore; doesn't attempt to be minimal across scattered edits.
 */
export function diffStrings(current: string, target: string): {
  start: number; deleteCount: number; insertText: string;
} {
  let start = 0;
  const minLen = Math.min(current.length, target.length);
  while (start < minLen && current[start] === target[start]) start++;
  let curEnd = current.length;
  let tgtEnd = target.length;
  while (curEnd > start && tgtEnd > start && current[curEnd - 1] === target[tgtEnd - 1]) {
    curEnd--; tgtEnd--;
  }
  return {
    start,
    deleteCount: curEnd - start,
    insertText: target.slice(start, tgtEnd),
  };
}
