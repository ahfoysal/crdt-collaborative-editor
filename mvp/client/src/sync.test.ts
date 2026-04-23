/**
 * Tests for SyncClient offline queueing + reconnect-merge semantics.
 *
 * We use a hand-rolled fake WebSocket so we can drive open/close/message
 * deterministically without any real network or timers-from-hell.
 *
 * IndexedDB is stubbed via `fake-indexeddb/auto` inside vitest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncClient } from './sync';
import { clearAll, loadAllOps, getMeta } from './persistence';
import type { Op } from './rga';

// ---- Fake WebSocket ------------------------------------------------------

type Listener = (ev: any) => void;

class FakeWS {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWS[] = [];

  readyState = 0;
  url: string;
  sent: string[] = [];
  onopen: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  onmessage: Listener | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWS.CLOSED) return;
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({});
  }

  // test helpers
  _open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.({});
  }
  _message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

// Install globally for this test file.
(globalThis as any).WebSocket = FakeWS;

function mkInsert(c: string, l: number, ch = 'a'): Op {
  return { type: 'insert', id: { c, l }, parent: null, ch };
}

describe('SyncClient', () => {
  beforeEach(async () => {
    FakeWS.instances = [];
    await clearAll();
  });

  it('sends hello with lastSeq on connect and flushes outbox', async () => {
    const client = new SyncClient('ws://x', 7, [], {
      onStatus: () => {},
      onRemoteOp: () => {},
    });
    client.connect();
    const ws = FakeWS.instances[0];

    await client.submitLocal(mkInsert('A', 1));
    expect(client.pendingCount).toBe(1);

    ws._open();
    // After open: hello, then the queued op
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs[0]).toEqual({ type: 'hello', lastSeq: 7 });
    expect(msgs[1]).toEqual({ type: 'op', op: mkInsert('A', 1) });
    expect(client.pendingCount).toBe(0);
  });

  it('buffers local ops while disconnected, flushes on reconnect', async () => {
    const client = new SyncClient('ws://x', 0, [], {
      onStatus: () => {},
      onRemoteOp: () => {},
    });
    client.connect();
    const ws1 = FakeWS.instances[0];
    ws1._open();
    ws1.sent.length = 0;

    client.goOffline();
    await client.submitLocal(mkInsert('A', 1));
    await client.submitLocal(mkInsert('A', 2));
    expect(client.pendingCount).toBe(2);

    client.goOnline();
    const ws2 = FakeWS.instances[1];
    ws2._open();
    const ops = ws2.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'op');
    expect(ops.map((m) => m.op.id.l)).toEqual([1, 2]);
    expect(client.pendingCount).toBe(0);
  });

  it('ingests remote ops, advances lastSeq, and ignores duplicates', async () => {
    const seen: Op[] = [];
    const client = new SyncClient('ws://x', 0, [], {
      onStatus: () => {},
      onRemoteOp: (op) => seen.push(op),
    });
    client.connect();
    const ws = FakeWS.instances[0];
    ws._open();

    ws._message({ type: 'op', seq: 1, op: mkInsert('B', 1) });
    ws._message({ type: 'op', seq: 2, op: mkInsert('B', 2) });
    // duplicate seq — must be dropped
    ws._message({ type: 'op', seq: 2, op: mkInsert('B', 2) });

    // handleMessage is async; yield to the microtask queue a few times.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(2);
    expect(await getMeta<number>('lastSeq')).toBe(2);
  });

  it('persists local ops to IDB before sending (durable outbox)', async () => {
    const client = new SyncClient('ws://x', 0, [], {
      onStatus: () => {},
      onRemoteOp: () => {},
    });
    client.connect();
    FakeWS.instances[0]._open();

    await client.submitLocal(mkInsert('A', 1));
    const stored = await loadAllOps();
    expect(stored).toHaveLength(1);
    expect(stored[0].local).toBe(true);
    expect(stored[0].op.id).toEqual({ c: 'A', l: 1 });
  });

  it('handles sync message with backfilled ops', async () => {
    const seen: Op[] = [];
    const client = new SyncClient('ws://x', 0, [], {
      onStatus: () => {},
      onRemoteOp: (op) => seen.push(op),
    });
    client.connect();
    const ws = FakeWS.instances[0];
    ws._open();

    ws._message({
      type: 'sync',
      ops: [
        { seq: 1, op: mkInsert('X', 1) },
        { seq: 2, op: mkInsert('X', 2) },
      ],
    });

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(seen.map((o) => (o as any).id.l)).toEqual([1, 2]);
    expect(await getMeta<number>('lastSeq')).toBe(2);
  });
});
