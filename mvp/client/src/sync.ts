/**
 * WebSocket sync + offline op queue.
 *
 * Protocol (v2, M2):
 *   client -> server  { type:'hello', lastSeq:number }
 *     Sent on every connect. Tells the server the highest seq the client has
 *     already applied. The server replies with a `sync` containing any ops
 *     whose seq is greater than lastSeq.
 *
 *   server -> client  { type:'sync', ops: [{ seq, op }, ...] }
 *     Backfill after a hello (or on first connect, where lastSeq=0 returns
 *     the full history).
 *
 *   client -> server  { type:'op', op }
 *     A local op. The client does NOT assign seq — that's the server's job.
 *
 *   server -> client  { type:'op', seq, op }
 *     A new op (either echoed local op or a remote one). Clients persist it
 *     with seq and advance their lastSeq watermark.
 *
 * Offline behavior:
 *   While the socket is not OPEN, local ops are buffered in `outbox` (also
 *   persisted to IDB as `local:true` entries). On reconnect we replay the
 *   outbox *after* sending hello — ops are idempotent on the server (keyed
 *   by their RGA OpId in the log) so duplicates from a crash-during-ack are
 *   dropped server-side.
 */
import type { Op } from './rga';
import { persistOp, setMeta, type StoredOp } from './persistence';

export type SyncEvents = {
  onRemoteOp: (op: Op) => void;
  onStatus: (connected: boolean, text: string) => void;
};

export class SyncClient {
  private ws: WebSocket | null = null;
  private url: string;
  private events: SyncEvents;

  /** Highest server-assigned seq we've applied + persisted. */
  private lastSeq: number;

  /** Local ops not yet sent to an open socket. */
  private outbox: Op[] = [];

  /** In-flight reconnect backoff (ms). */
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, lastSeq: number, pendingOutbox: Op[], events: SyncEvents) {
    this.url = url;
    this.lastSeq = lastSeq;
    this.outbox = [...pendingOutbox];
    this.events = events;
  }

  connect(): void {
    this.events.onStatus(false, 'connecting…');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.events.onStatus(true, 'connected');
      ws.send(JSON.stringify({ type: 'hello', lastSeq: this.lastSeq }));
      this.flushOutbox();
    };

    ws.onclose = () => {
      this.ws = null;
      this.events.onStatus(
        false,
        this.outbox.length > 0
          ? `offline — ${this.outbox.length} op(s) queued`
          : 'offline — reconnecting…',
      );
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire right after; no-op here.
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }

    if (msg.type === 'sync' && Array.isArray(msg.ops)) {
      for (const entry of msg.ops) {
        if (!entry || typeof entry.seq !== 'number' || !entry.op) continue;
        await this.ingestRemote(entry.seq, entry.op as Op);
      }
    } else if (msg.type === 'op' && typeof msg.seq === 'number' && msg.op) {
      await this.ingestRemote(msg.seq, msg.op as Op);
    }
  }

  private async ingestRemote(seq: number, op: Op): Promise<void> {
    // Advance the watermark synchronously so concurrent message handlers
    // (e.g. duplicates from overlapping sync+op streams) can't all race past
    // the check before any of them updates `lastSeq`.
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    this.events.onRemoteOp(op);
    const entry: StoredOp = { seq, op, local: false, t: Date.now() };
    await persistOp(entry);
    await setMeta('lastSeq', seq);
  }

  /**
   * Enqueue a locally-produced op. Persisted to IDB immediately (so a crash
   * before we reach the wire doesn't lose the edit), and sent if we're online.
   */
  async submitLocal(op: Op): Promise<void> {
    await persistOp({ op, local: true, t: Date.now() });
    this.outbox.push(op);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.flushOutbox();
    } else {
      this.events.onStatus(false, `offline — ${this.outbox.length} op(s) queued`);
    }
  }

  private flushOutbox(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.outbox.length > 0) {
      const op = this.outbox.shift()!;
      this.ws.send(JSON.stringify({ type: 'op', op }));
    }
    this.events.onStatus(true, 'connected');
  }

  /** For the demo UI: force the socket shut to simulate going offline. */
  goOffline(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.events.onStatus(false, `offline — ${this.outbox.length} op(s) queued`);
  }

  goOnline(): void {
    if (this.ws) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = 500;
    this.connect();
  }

  get pendingCount(): number {
    return this.outbox.length;
  }
}
