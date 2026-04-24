import { describe, it, expect } from 'vitest';
import { OpLog } from './oplog.js';
import { HistoryStore } from './history.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('HistoryStore', () => {
  it('captures snapshots that scope the oplog to a prior seq', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-'));
    const log = new OpLog(join(dir, 'log.json'));
    await log.load();
    const hist = new HistoryStore(log, join(dir, 'hist.json'));
    await hist.load();

    // 3 ops, snapshot, 2 more ops.
    log.append({ type: 'insert', id: { c: 'a', l: 1 }, ch: 'x' });
    log.append({ type: 'insert', id: { c: 'a', l: 2 }, ch: 'y' });
    log.append({ type: 'insert', id: { c: 'a', l: 3 }, ch: 'z' });
    const s1 = hist.captureNow('after-xyz')!;
    expect(s1.seq).toBe(3);

    log.append({ type: 'insert', id: { c: 'a', l: 4 }, ch: 'q' });
    log.append({ type: 'insert', id: { c: 'a', l: 5 }, ch: 'r' });
    const s2 = hist.captureNow()!;
    expect(s2.seq).toBe(5);

    const opsAtS1 = hist.opsAt(s1.id)!;
    expect(opsAtS1).toHaveLength(3);
    expect(opsAtS1.map((e) => e.op.ch)).toEqual(['x', 'y', 'z']);

    const opsAtS2 = hist.opsAt(s2.id)!;
    expect(opsAtS2).toHaveLength(5);

    // captureNow dedupes when no new ops and no label.
    expect(hist.captureNow()).toBeNull();
    // but a labeled capture always succeeds.
    expect(hist.captureNow('manual')).not.toBeNull();

    await hist.flush();
    await log.flush();
    await rm(dir, { recursive: true, force: true });
  });
});
