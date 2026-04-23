import { WebSocketServer, WebSocket } from 'ws';
import { OpLog } from './oplog.js';

const PORT = Number(process.env.PORT ?? 8787);
const LOG_PATH = process.env.OPLOG_PATH ?? './oplog.json';

/**
 * M2 relay:
 *   - Keeps a persistent, monotonically-sequenced op log on disk (JSON file).
 *   - Each incoming op is deduplicated by its RGA OpId ({c,l}) so retries from
 *     a reconnecting client don't double-apply.
 *   - On connect, the client sends { type:'hello', lastSeq } and we stream back
 *     every op with seq > lastSeq as a single `sync` message.
 *   - Every accepted op is broadcast to all other clients with its assigned seq.
 *
 * The server is still CRDT-agnostic: it never interprets op bodies, it only
 * tracks identity + order.
 */

type Op = { type: 'insert' | 'delete'; id: { c: string; l: number }; [k: string]: unknown };
type LogEntry = { seq: number; op: Op };

const log = new OpLog(LOG_PATH);
await log.load();

const wss = new WebSocketServer({ port: PORT });

function safeParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw) => {
    const text = raw.toString();
    const msg = safeParse(text);
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      const lastSeq = typeof msg.lastSeq === 'number' ? msg.lastSeq : 0;
      const missed = log.since(lastSeq);
      ws.send(JSON.stringify({ type: 'sync', ops: missed }));
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
  });
});

console.log(
  `[crdt-mvp-server] listening on ws://localhost:${PORT} (log=${LOG_PATH}, seq=${log.head()})`,
);

export type { LogEntry, Op };
