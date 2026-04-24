/**
 * Load test: N simulated clients connect to the relay, make random edits, and
 * then wait for convergence.
 *
 * Config (env):
 *   CLIENTS=100          number of simulated clients
 *   OPS_PER_CLIENT=20    edits per client
 *   EDIT_INTERVAL_MS=50  mean delay between edits per client (jittered ±50%)
 *   SETTLE_MS=5000       time to wait after the last edit before checking
 *   URL=ws://localhost:8787
 *   JWT_SECRET=...       same secret the server uses (ignored if AUTH_DISABLED)
 *   AUTH_DISABLED=1      skip JWT — matches server default
 *
 * What it checks:
 *   1. All clients connect + receive `sync`
 *   2. Ops flow freely (no rejections on editor role)
 *   3. After settling, every client's RGA rendering is byte-identical
 *   4. Process memory stays under a sane ceiling (logged, not asserted)
 *
 * Run:
 *   # terminal 1
 *   cd mvp/server && AUTH_DISABLED=1 OPLOG_PATH=./loadtest-oplog.json npm run server
 *   # terminal 2
 *   cd mvp/loadtest && npm install && npm run load
 */
import WebSocket from 'ws';
import { createHmac } from 'node:crypto';
import { RGA, type Op } from './rga.js';

const CLIENTS = Number(process.env.CLIENTS ?? 100);
const OPS_PER_CLIENT = Number(process.env.OPS_PER_CLIENT ?? 20);
const EDIT_INTERVAL_MS = Number(process.env.EDIT_INTERVAL_MS ?? 50);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5000);
const URL = process.env.URL ?? 'ws://localhost:8787';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-shared-secret-change-me';
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';

// -- token mint (HS256) — mirrors server/src/auth.ts -----------------------
function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function mintToken(sub: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { sub, iat: Math.floor(Date.now() / 1000) };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = b64url(createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

type Client = {
  id: string;
  ws: WebSocket;
  rga: RGA;
  received: number;
  sent: number;
  rejected: number;
  connected: boolean;
  helloAcked: boolean;
};

function jitter(ms: number): number {
  return ms * (0.5 + Math.random());
}

function randomWord(): string {
  const len = 3 + Math.floor(Math.random() * 6);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s + ' ';
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function memMb(): number {
  const { rss } = process.memoryUsage();
  return Math.round((rss / 1024 / 1024) * 10) / 10;
}

async function spawnClient(idx: number): Promise<Client> {
  const id = `lt-${idx.toString().padStart(4, '0')}`;
  const ws = new WebSocket(URL);
  const rga = new RGA(id);
  const c: Client = { id, ws, rga, received: 0, sent: 0, rejected: 0, connected: false, helloAcked: false };

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'sync' && Array.isArray(msg.ops)) {
      for (const entry of msg.ops) rga.applyRemote(entry.op as Op);
      c.helloAcked = true;
    } else if (msg.type === 'op' && msg.op) {
      if (rga.applyRemote(msg.op as Op)) c.received++;
    } else if (msg.type === 'op-rejected') {
      c.rejected++;
    } else if (msg.type === 'welcome') {
      c.helloAcked = true;
    }
  });

  ws.on('close', () => { c.connected = false; });
  ws.on('error', () => { /* swallowed; we'll see it via missing convergence */ });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => { c.connected = true; resolve(); });
    ws.once('error', reject);
  });

  const hello: any = { type: 'hello', lastSeq: 0, clientId: id };
  if (!AUTH_DISABLED) hello.token = mintToken(id);
  ws.send(JSON.stringify(hello));

  return c;
}

async function runClientLoop(c: Client): Promise<void> {
  for (let i = 0; i < OPS_PER_CLIENT; i++) {
    await new Promise((r) => setTimeout(r, jitter(EDIT_INTERVAL_MS)));
    if (!c.connected) return;

    const len = c.rga.visibleLength();
    // 30% delete, 70% insert (skip delete on empty doc).
    const doDelete = len > 5 && Math.random() < 0.3;
    let ops: Op[];
    if (doDelete) {
      const at = Math.floor(Math.random() * (len - 1));
      const count = 1 + Math.floor(Math.random() * Math.min(3, len - at));
      ops = c.rga.localDelete(at, count);
    } else {
      const at = Math.floor(Math.random() * (len + 1));
      ops = c.rga.localInsert(at, randomWord());
    }
    for (const op of ops) {
      c.ws.send(JSON.stringify({ type: 'op', op }));
      c.sent++;
    }
  }
}

async function main() {
  const t0 = Date.now();
  console.log(`[loadtest] N=${CLIENTS} ops/client=${OPS_PER_CLIENT} url=${URL} auth=${AUTH_DISABLED ? 'disabled' : 'JWT'}`);
  console.log(`[loadtest] rss=${memMb()}MB at start`);

  const clients: Client[] = [];
  const connectStart = Date.now();
  // Spawn in waves of 25 to avoid thundering-herd refusing connections.
  const WAVE = 25;
  for (let i = 0; i < CLIENTS; i += WAVE) {
    const waveSize = Math.min(WAVE, CLIENTS - i);
    const spawned = await Promise.all(
      Array.from({ length: waveSize }, (_, k) => spawnClient(i + k)),
    );
    clients.push(...spawned);
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`[loadtest] connected ${clients.length} clients in ${Date.now() - connectStart}ms`);

  // Wait for all hello acks.
  const allHelloed = await waitFor(
    () => clients.every((c) => c.helloAcked),
    10_000,
  );
  if (!allHelloed) {
    const missing = clients.filter((c) => !c.helloAcked).length;
    console.warn(`[loadtest] WARN ${missing} clients never received hello-ack`);
  }

  const editStart = Date.now();
  await Promise.all(clients.map((c) => runClientLoop(c)));
  console.log(`[loadtest] all edit loops finished in ${Date.now() - editStart}ms`);

  const totalSent = clients.reduce((a, c) => a + c.sent, 0);
  const totalRejected = clients.reduce((a, c) => a + c.rejected, 0);
  console.log(`[loadtest] ops sent=${totalSent} rejected=${totalRejected}`);

  // Wait for fanout to quiesce. Poll up to SETTLE_MS; exit early once every
  // client has received the same number of ops and that number hasn't budged
  // for two consecutive checks.
  console.log(`[loadtest] settling up to ${SETTLE_MS}ms…`);
  let stableTicks = 0;
  let prevTotal = -1;
  for (let elapsed = 0; elapsed < SETTLE_MS; elapsed += 500) {
    await new Promise((r) => setTimeout(r, 500));
    const received = clients.map((c) => c.received);
    const min = Math.min(...received);
    const max = Math.max(...received);
    const total = received.reduce((a, b) => a + b, 0);
    if (min === max && total === prevTotal) {
      stableTicks++;
      if (stableTicks >= 2) {
        console.log(`[loadtest] quiesced after ${elapsed + 500}ms`);
        break;
      }
    } else {
      stableTicks = 0;
    }
    prevTotal = total;
  }

  // Convergence check: are all rendered strings identical?
  const strings = clients.map((c) => c.rga.toString());
  const ref = strings[0];
  let diverged = 0;
  const lengths = new Set<number>();
  for (const s of strings) {
    lengths.add(s.length);
    if (s !== ref) diverged++;
  }

  console.log(`[loadtest] rss=${memMb()}MB after edits`);
  console.log(`[loadtest] doc length: ${ref.length} (distinct lengths seen: ${[...lengths].join(',')})`);
  console.log(`[loadtest] convergence: ${diverged === 0 ? 'OK — all clients identical' : `FAIL — ${diverged}/${clients.length} diverged`}`);

  // Per-client receive stats.
  const receivedStats = clients.map((c) => c.received).sort((a, b) => a - b);
  const median = receivedStats[Math.floor(receivedStats.length / 2)];
  console.log(`[loadtest] ops received — min=${receivedStats[0]} median=${median} max=${receivedStats[receivedStats.length - 1]}`);

  // Tear down.
  for (const c of clients) try { c.ws.close(); } catch { /* noop */ }
  await new Promise((r) => setTimeout(r, 200));

  const totalMs = Date.now() - t0;
  console.log(`[loadtest] done in ${totalMs}ms rss=${memMb()}MB`);

  process.exit(diverged === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[loadtest] fatal', err);
  process.exit(2);
});
