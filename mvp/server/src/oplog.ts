import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append-only op log persisted as a JSON file.
 *
 * Storage format: a single JSON array of `{ seq, op }` entries. We rewrite the
 * whole file on every append — fine for the MVP's scale. A future version
 * would switch to newline-delimited JSON for O(1) append.
 *
 * Dedup: we key by `op.id` (RGA OpId `{c,l}`) so a client that retries the
 * same op after a flaky disconnect doesn't get a second seq.
 *
 * Persistence: writes are scheduled via a serial chain (`writeQueue`) so
 * concurrent `append()` calls can't interleave file writes. Each append
 * awaits the prior write before issuing its own.
 */
export type Op = { id: { c: string; l: number }; [k: string]: unknown };
export type LogEntry = { seq: number; op: Op };

export class OpLog {
  private entries: LogEntry[] = [];
  private seen = new Set<string>();
  private path: string;
  private writeQueue: Promise<void> = Promise.resolve();
  /** When set, coalesces appends into a single write per tick. */
  private readonly coalesceWrites: boolean;
  private writeScheduled = false;

  constructor(path: string, opts: { coalesceWrites?: boolean } = {}) {
    this.path = path;
    // Default on — keeps file in sync without rewriting per-op under load.
    this.coalesceWrites = opts.coalesceWrites ?? true;
  }

  private static idKey(op: Op): string {
    return `${op.id.c}:${op.id.l}`;
  }

  async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as LogEntry[];
      if (!Array.isArray(parsed)) return;
      this.entries = parsed;
      for (const e of parsed) this.seen.add(OpLog.idKey(e.op));
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Append an op. Returns the written entry, or null if the op was a dup.
   * Persists asynchronously — caller doesn't have to await, but can call
   * `flush()` to be sure the write hit disk.
   */
  append(op: Op): LogEntry | null {
    const key = OpLog.idKey(op);
    if (this.seen.has(key)) return null;
    const entry: LogEntry = { seq: this.entries.length + 1, op };
    this.entries.push(entry);
    this.seen.add(key);
    this.schedulePersist();
    return entry;
  }

  /** All entries with seq > `afterSeq`. */
  since(afterSeq: number): LogEntry[] {
    if (afterSeq <= 0) return this.entries.slice();
    return this.entries.filter((e) => e.seq > afterSeq);
  }

  head(): number {
    return this.entries.length;
  }

  private schedulePersist(): void {
    if (this.coalesceWrites) {
      // Debounce — one write per macrotask, capturing whatever has
      // accumulated. Burst loads go from O(N) file rewrites to O(1-ish).
      // The setImmediate is chained *onto* writeQueue so flush() awaiting
      // writeQueue is guaranteed to await the pending write too.
      if (this.writeScheduled) return;
      this.writeScheduled = true;
      this.writeQueue = this.writeQueue.then(
        () => new Promise<void>((resolve) => {
          setImmediate(() => {
            this.writeScheduled = false;
            this.writeFile().then(resolve, (err) => {
              console.error('[oplog] persist failed', err);
              resolve();
            });
          });
        }),
      );
      return;
    }
    this.writeQueue = this.writeQueue.then(() => this.writeFile());
    this.writeQueue.catch((err) => {
      console.error('[oplog] persist failed', err);
    });
  }

  async flush(): Promise<void> {
    // writeQueue already includes any coalesced work because schedulePersist
    // chains the setImmediate onto it rather than orphaning it.
    await this.writeQueue;
  }

  private async writeFile(): Promise<void> {
    const dir = dirname(this.path);
    if (dir && dir !== '.') {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch {
        /* noop */
      }
    }
    const tmp = this.path + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.entries), 'utf8');
    await fs.rename(tmp, this.path);
  }
}
