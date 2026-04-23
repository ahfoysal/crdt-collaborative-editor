/**
 * IndexedDB persistence for the CRDT op log and sync cursor.
 *
 * We persist the full stream of ops the client has seen (both local and remote)
 * keyed by a monotonic auto-increment, plus a small `meta` store holding the
 * highest server-assigned `seq` we've acknowledged and a stable clientId.
 *
 * On boot the client replays everything from the `ops` store into a fresh RGA
 * instance, which restores document state without any server round-trip.
 * Because RGA ops are idempotent and commutative, replaying in any order still
 * converges — but we replay in insertion order anyway for predictability.
 *
 * We deliberately avoid `idb-keyval` here so the MVP has zero new runtime
 * deps. ~90 lines of raw IDB is enough.
 */
import type { Op } from './rga';

const DB_NAME = 'crdt-mvp';
const DB_VERSION = 1;
const STORE_OPS = 'ops';
const STORE_META = 'meta';

export type StoredOp = {
  // server-assigned monotonic seq (undefined for local ops not yet acked)
  seq?: number;
  op: Op;
  // true if this op originated locally; used to replay the outbox on boot
  local: boolean;
  // local insertion timestamp — strictly for debugging
  t: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_OPS)) {
        db.createObjectStore(STORE_OPS, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, stores: string[], mode: IDBTransactionMode) {
  return db.transaction(stores, mode);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Append one op. Called for every local op *and* every accepted remote op. */
export async function persistOp(entry: StoredOp): Promise<void> {
  const db = await openDb();
  const t = tx(db, [STORE_OPS], 'readwrite');
  t.objectStore(STORE_OPS).add(entry);
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Read everything back in insertion order. */
export async function loadAllOps(): Promise<StoredOp[]> {
  const db = await openDb();
  const store = tx(db, [STORE_OPS], 'readonly').objectStore(STORE_OPS);
  return (await reqToPromise(store.getAll())) as StoredOp[];
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const store = tx(db, [STORE_META], 'readonly').objectStore(STORE_META);
  return (await reqToPromise(store.get(key))) as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const t = tx(db, [STORE_META], 'readwrite');
  t.objectStore(STORE_META).put(value, key);
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Get-or-create a stable client id persisted across reloads. */
export async function getOrCreateClientId(): Promise<string> {
  const existing = await getMeta<string>('clientId');
  if (existing) return existing;
  const id = Math.random().toString(36).slice(2, 8);
  await setMeta('clientId', id);
  return id;
}

/** Wipe everything — useful for the "reset" button / tests. */
export async function clearAll(): Promise<void> {
  const db = await openDb();
  const t = tx(db, [STORE_OPS, STORE_META], 'readwrite');
  t.objectStore(STORE_OPS).clear();
  t.objectStore(STORE_META).clear();
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
