import { WebSocketServer, WebSocket } from 'ws';
import { OpLog } from './oplog.js';
import { HistoryStore, SNAPSHOT_INTERVAL_MS } from './history.js';
import {
  PermsStore,
  authenticateHello,
  AUTH_DISABLED,
  type AuthPayload,
} from './auth.js';

const PORT = Number(process.env.PORT ?? 8787);
const LOG_PATH = process.env.OPLOG_PATH ?? './oplog.json';
const HISTORY_PATH = process.env.HISTORY_PATH ?? './history.json';
const PERMS_PATH = process.env.PERMS_PATH ?? './perms.json';
const DOC_ID = process.env.DOC_ID ?? 'default';

/**
 * Relay server.
 *
 * M2 semantics (unchanged):
 *   - OpLog dedupes by RGA OpId, assigns seq, persists to JSON.
 *   - `hello { lastSeq }` returns `sync { ops }` for missed seqs.
 *
 * M4 (unchanged):
 *   - Tracks `clientId` per socket, relays `presence` + `signal`.
 *
 * M5:
 *   - `hello` now carries a JWT `token` (unless AUTH_DISABLED=1). The payload's
 *     `sub` is the authenticated userId; `clientId` is still the RGA client id
 *     (per-tab / per-device) but the role lookup uses `sub`.
 *   - Roles (owner/editor/viewer) come from a PermsStore. First connection to
 *     a fresh doc becomes the owner. Viewer tokens get `sync` + presence but
 *     their `op` messages are silently rejected (and we tell them so once).
 *   - HistoryStore takes a snapshot every minute. Clients can list snapshots
 *     (`{type:'history:list'}`) and fetch one (`{type:'history:get', id}`).
 */

type Op = { type: 'insert' | 'delete'; id: { c: string; l: number }; [k: string]: unknown };

const log = new OpLog(LOG_PATH);
await log.load();

const history = new HistoryStore(log, HISTORY_PATH);
await history.load();
history.startAuto();

const perms = new PermsStore(PERMS_PATH);
await perms.load();

const wss = new WebSocketServer({ port: PORT });

// clientId -> socket. One socket per clientId at any given time.
const sockets = new Map<string, WebSocket>();
// ws -> {auth, clientId}. Stored so message handlers can check role cheaply.
const sessions = new WeakMap<WebSocket, { auth: AuthPayload; clientId: string }>();

function safeParse(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

function broadcast(msg: unknown, exclude?: WebSocket) {
  const out = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client === exclude) continue;
    if (client.readyState === WebSocket.OPEN) client.send(out);
  }
}

wss.on('connection', (ws: WebSocket) => {
  let clientId: string | null = null;

  ws.on('message', (raw) => {
    const text = raw.toString();
    const msg = safeParse(text);
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      const auth = authenticateHello(msg);
      if (!auth) {
        ws.send(JSON.stringify({ type: 'auth-error', reason: 'invalid or missing token' }));
        try { ws.close(4401, 'unauthorized'); } catch { /* noop */ }
        return;
      }

      // First connection to a brand-new doc becomes the owner.
      perms.ensureDoc(DOC_ID, auth.sub);

      const role = AUTH_DISABLED ? 'editor' : (perms.roleOf(DOC_ID, auth.sub) ?? 'viewer');
      if (!perms.canRead(DOC_ID, auth.sub)) {
        ws.send(JSON.stringify({ type: 'auth-error', reason: 'no read access' }));
        try { ws.close(4403, 'forbidden'); } catch { /* noop */ }
        return;
      }

      const lastSeq = typeof msg.lastSeq === 'number' ? msg.lastSeq : 0;
      const newId = typeof msg.clientId === 'string' ? msg.clientId : auth.sub;

      const prev = sockets.get(newId);
      if (prev && prev !== ws) {
        try { prev.close(); } catch { /* noop */ }
      }
      clientId = newId;
      sockets.set(newId, ws);
      sessions.set(ws, { auth, clientId: clientId as string });

      const missed = log.since(lastSeq);
      ws.send(JSON.stringify({ type: 'sync', ops: missed }));
      ws.send(JSON.stringify({ type: 'welcome', userId: auth.sub, role, docId: DOC_ID }));

      const peers = [...sockets.keys()].filter((id) => id !== clientId);
      ws.send(JSON.stringify({ type: 'peers', peers }));
      broadcast({ type: 'peer-join', clientId }, ws);
      return;
    }

    const session = sessions.get(ws);
    if (!session) {
      if (process.env.DEBUG_DROPS) console.log('[drop] no session for', msg.type);
      return; // must hello first
    }

    if (msg.type === 'op' && msg.op && msg.op.id) {
      if (!perms.canWrite(DOC_ID, session.auth.sub)) {
        ws.send(JSON.stringify({ type: 'op-rejected', reason: 'viewer role — read only' }));
        return;
      }
      const entry = log.append(msg.op as Op);
      if (!entry) {
        if (process.env.DEBUG_DROPS) console.log('[dup]', (msg.op as any).id);
        return;
      }
      const out = JSON.stringify({ type: 'op', seq: entry.seq, op: entry.op });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(out);
      }
      return;
    }

    if (msg.type === 'presence' && msg.state && typeof msg.state === 'object') {
      const state = { ...msg.state, clientId: clientId ?? msg.state.clientId };
      broadcast({ type: 'presence', state }, ws);
      return;
    }

    if (msg.type === 'signal' && typeof msg.to === 'string') {
      if (!clientId) return;
      const target = sockets.get(msg.to);
      if (!target || target.readyState !== WebSocket.OPEN) return;
      target.send(JSON.stringify({
        type: 'signal', from: clientId, to: msg.to, data: msg.data,
      }));
      return;
    }

    // -- History ----------------------------------------------------------
    if (msg.type === 'history:list') {
      ws.send(JSON.stringify({ type: 'history:list', snapshots: history.list() }));
      return;
    }

    if (msg.type === 'history:get' && typeof msg.id === 'string') {
      const ops = history.opsAt(msg.id);
      if (!ops) {
        ws.send(JSON.stringify({ type: 'history:get', id: msg.id, error: 'not found' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'history:get', id: msg.id, ops }));
      return;
    }

    if (msg.type === 'history:snapshot') {
      // Allow any editor to request a manual snapshot.
      if (!perms.canWrite(DOC_ID, session.auth.sub)) return;
      const snap = history.captureNow(typeof msg.label === 'string' ? msg.label : undefined);
      ws.send(JSON.stringify({ type: 'history:snapshot', snapshot: snap }));
      return;
    }

    // -- Permissions (owner-only) ----------------------------------------
    if (msg.type === 'perms:set' && typeof msg.userId === 'string' && typeof msg.role === 'string') {
      const ok = perms.setRole(DOC_ID, session.auth.sub, msg.userId, msg.role);
      ws.send(JSON.stringify({ type: 'perms:set', ok, userId: msg.userId, role: msg.role }));
      return;
    }

    if (msg.type === 'perms:get') {
      ws.send(JSON.stringify({ type: 'perms:get', perms: perms.get(DOC_ID) }));
      return;
    }
  });

  ws.on('close', () => {
    if (clientId && sockets.get(clientId) === ws) {
      sockets.delete(clientId);
      broadcast({ type: 'peer-leave', clientId });
    }
  });
});

console.log(
  `[crdt-mvp-server] listening on ws://localhost:${PORT} ` +
  `(log=${LOG_PATH}, seq=${log.head()}, auth=${AUTH_DISABLED ? 'disabled' : 'JWT'}, ` +
  `snapshot=${SNAPSHOT_INTERVAL_MS}ms)`,
);

export type { Op };
