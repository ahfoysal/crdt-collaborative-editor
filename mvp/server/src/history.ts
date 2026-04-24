/**
 * Version history (M5).
 *
 * A snapshot is a point-in-time capture of the oplog: we record the current
 * `seq` head plus metadata (timestamp, optional label). To reconstruct the
 * document at that moment we replay `log.since(0)` up to and including the
 * captured seq — i.e. `log.entries().filter(e => e.seq <= snap.seq)`.
 *
 * Snapshots are cheap (just a number + a timestamp). A fresh snapshot is
 * created every `SNAPSHOT_INTERVAL_MS` (default 60s) as long as at least one
 * new op has been appended since the previous one. Deduping is important so
 * an idle server doesn't accumulate a snapshot per minute forever.
 *
 * "Restore" is implemented client-side: the client fetches the ops list for
 * the target snapshot, rebuilds the CRDT, diffs against current, and emits
 * the necessary local ops to make the live doc match the snapshot.  That way
 * restore is just normal editing from the CRDT's point of view and keeps
 * convergence properties. The server just serves the snapshot list and the
 * ops up to a given seq.
 */
import { promises as fs } from 'node:fs';
import type { OpLog, LogEntry } from './oplog.js';

export type Snapshot = {
  id: string;        // unique id; we use `snap-<seq>-<ts>`
  seq: number;       // highest included seq
  t: number;         // ms since epoch
  label?: string;    // optional human-readable label
};

export const SNAPSHOT_INTERVAL_MS = Number(
  process.env.SNAPSHOT_INTERVAL_MS ?? 60_000,
);

export class HistoryStore {
  private snapshots: Snapshot[] = [];
  private path: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: OpLog;

  constructor(log: OpLog, path: string) {
    this.log = log;
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Snapshot[];
      if (Array.isArray(parsed)) this.snapshots = parsed;
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  }

  list(): Snapshot[] {
    return this.snapshots.slice();
  }

  /** Ops at or before snapshot's seq — i.e. the doc state as of that moment. */
  opsAt(snapshotId: string): LogEntry[] | null {
    const snap = this.snapshots.find((s) => s.id === snapshotId);
    if (!snap) return null;
    return this.log.since(0).filter((e) => e.seq <= snap.seq);
  }

  /** Take a snapshot now. Returns null if there are no new ops since last. */
  captureNow(label?: string): Snapshot | null {
    const seq = this.log.head();
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && last.seq === seq && !label) return null;
    const snap: Snapshot = {
      id: `snap-${seq}-${Date.now()}`,
      seq,
      t: Date.now(),
      ...(label ? { label } : {}),
    };
    this.snapshots.push(snap);
    this.schedulePersist();
    return snap;
  }

  /** Start automatic per-interval snapshotting. */
  startAuto(intervalMs: number = SNAPSHOT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.captureNow();
      } catch (err) {
        console.error('[history] auto-snapshot failed', err);
      }
    }, intervalMs);
    // Don't keep the process alive solely for snapshotting.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as any).unref?.();
    }
  }

  stopAuto(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private schedulePersist(): void {
    this.writeQueue = this.writeQueue.then(() => this.writeFile());
    this.writeQueue.catch((err) => console.error('[history] persist failed', err));
  }

  private async writeFile(): Promise<void> {
    const tmp = this.path + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.snapshots, null, 2), 'utf8');
    await fs.rename(tmp, this.path);
  }
}
