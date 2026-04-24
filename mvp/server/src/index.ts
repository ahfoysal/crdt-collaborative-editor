import { WebSocketServer, WebSocket } from 'ws';
import { OpLog } from './oplog.js';

const PORT = Number(process.env.PORT ?? 8787);
const LOG_PATH = process.env.OPLOG_PATH ?? './oplog.json';

/**
 * Relay server.
 *
 * M2 op log semantics are unchanged:
 *   - Dedupes by RGA OpId ({c,l}), assigns seq, persists to JSON oplog.
 *   - `hello { lastSeq }` returns `sync { ops }` for missed seqs.
 *   - Each accepted `op` is broadcast as `{type:'op', seq, op}`.
 *
 * M4 additions (all ephemeral — nothing below touches the oplog):
 *   - `hello` includes `clientId` so the server tracks who's on each socket.
 *     The server replies with `{type:'peers', peers:[clientId,...]}` listing
 *     the other connected clients, and broadcasts `{type:'peer-join', clientId}`
 *     to everyone else. On disconnect it broadcasts `{type:'peer-leave'}`.
 *   - `{type:'presence', state}` is broadcast verbatim to the other sockets.
 *     No persistence — presence dies with the socket.
 *   - `{type:'signal', to, data}` is routed to the socket owned by `to`.
 *     This is the signaling channel for WebRTC offer/answer/ICE. `from` is
 *     filled in by the server from the connection's clientId, so clients
 *     can't spoof each other.
 */

type Op = { type: 'insert' | 'delete'; id: { c: string; l: number }; [k: string]: unknown };
type LogEntry = { seq: number; op: Op };

const log = new OpLog(LOG_PATH);
await log.load();

const wss = new WebSocketServer({ port: PORT });

// clientId -> socket. One socket per clientId at any given time.
const sockets = new Map<string, WebSocket>();

function safeParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function broadcast(msg: unknown, exclude?: WebSocket) {
  const out = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client === exclude) continue;
    if (client.readyState === WebSocket.OPEN) client.send(out);
  }
}

wss.on('connection', (ws: WebSocket) => {
  // clientId is learned from the `hello`; until then the socket is anonymous.
  let clientId: string | null = null;

  ws.on('message', (raw) => {
    const text = raw.toString();
    const msg = safeParse(text);
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      const lastSeq = typeof msg.lastSeq === 'number' ? msg.lastSeq : 0;
      const newId = typeof msg.clientId === 'string' ? msg.clientId : null;

      // Register the socket's clientId. If another socket already claims the
      // same id (e.g. tab reload before onclose fires), evict the stale one.
      if (newId) {
        const prev = sockets.get(newId);
        if (prev && prev !== ws) {
          try { prev.close(); } catch { /* noop */ }
        }
        clientId = newId;
        sockets.set(newId, ws);
      }

      const missed = log.since(lastSeq);
      ws.send(JSON.stringify({ type: 'sync', ops: missed }));

      if (clientId) {
        // Announce current peer list to the new client.
        const peers = [...sockets.keys()].filter((id) => id !== clientId);
        ws.send(JSON.stringify({ type: 'peers', peers }));
        // Announce new peer to everyone else.
        broadcast({ type: 'peer-join', clientId }, ws);
      }
      return;
    }

    if (msg.type === 'op' && msg.op && msg.op.id) {
      const entry = log.append(msg.op as Op);
      if (!entry) return; // duplicate — already in log
      const out = JSON.stringify({ type: 'op', seq: entry.seq, op: entry.op });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(out);
      }
      return;
    }

    if (msg.type === 'presence' && msg.state && typeof msg.state === 'object') {
      // Ephemeral — never touches the oplog. Stamp the author from the socket
      // so clients can't spoof others.
      const state = { ...msg.state, clientId: clientId ?? msg.state.clientId };
      broadcast({ type: 'presence', state }, ws);
      return;
    }

    if (msg.type === 'signal' && typeof msg.to === 'string') {
      if (!clientId) return;
      const target = sockets.get(msg.to);
      if (!target || target.readyState !== WebSocket.OPEN) return;
      target.send(JSON.stringify({
        type: 'signal',
        from: clientId,
        to: msg.to,
        data: msg.data,
      }));
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
  `[crdt-mvp-server] listening on ws://localhost:${PORT} (log=${LOG_PATH}, seq=${log.head()})`,
);

export type { LogEntry, Op };
