import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpLog, type Op } from './oplog.js';

let activeLog: OpLog | null = null;

function mkop(c: string, l: number, ch = 'x'): Op {
  return { type: 'insert', id: { c, l }, ch } as Op;
}

describe('OpLog', () => {
  let path: string;

  beforeEach(async () => {
    path = join(tmpdir(), `oplog-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(async () => {
    // Wait for any pending persist writes so we don't rename into a deleted file.
    if (activeLog) await activeLog.flush();
    activeLog = null;
    await fs.rm(path, { force: true });
    await fs.rm(path + '.tmp', { force: true });
  });

  it('assigns monotonic seq starting at 1', async () => {
    const log = new OpLog(path); activeLog = log;
    await log.load();
    const a = log.append(mkop('A', 1));
    const b = log.append(mkop('A', 2));
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(2);
    expect(log.head()).toBe(2);
  });

  it('deduplicates ops by id', async () => {
    const log = new OpLog(path); activeLog = log;
    await log.load();
    expect(log.append(mkop('A', 1))).not.toBeNull();
    expect(log.append(mkop('A', 1))).toBeNull();
    expect(log.head()).toBe(1);
  });

  it('since(n) returns only entries with seq > n', async () => {
    const log = new OpLog(path); activeLog = log;
    await log.load();
    log.append(mkop('A', 1));
    log.append(mkop('A', 2));
    log.append(mkop('A', 3));
    expect(log.since(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.since(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(log.since(3)).toEqual([]);
  });

  it('persists to disk and reloads with seen-set intact', async () => {
    const a = new OpLog(path); activeLog = a;
    await a.load();
    a.append(mkop('A', 1));
    a.append(mkop('B', 1));
    await a.flush();

    const b = new OpLog(path); activeLog = b;
    await b.load();
    expect(b.head()).toBe(2);
    // Reloaded log must still dedupe existing ids
    expect(b.append(mkop('A', 1))).toBeNull();
    // And assign the next seq for a new op
    expect(b.append(mkop('C', 1))?.seq).toBe(3);
  });

  it('handles missing file as an empty log', async () => {
    const log = new OpLog(path); activeLog = log;
    await log.load();
    expect(log.head()).toBe(0);
    expect(log.since(0)).toEqual([]);
  });
});
