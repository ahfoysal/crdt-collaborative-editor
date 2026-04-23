import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);

/**
 * MVP relay: broadcasts every message it receives to every *other* connected
 * client verbatim. Ops are opaque to the server — all CRDT logic lives in the
 * client. The server also keeps an in-memory op log so new clients can catch
 * up on the current document state when they connect.
 */
const wss = new WebSocketServer({ port: PORT });
const opLog: string[] = []; // raw JSON strings of op messages

wss.on('connection', (ws: WebSocket) => {
  // Replay history to the new client so it converges to current state.
  if (opLog.length > 0) {
    ws.send(JSON.stringify({ type: 'sync', ops: opLog.map((s) => JSON.parse(s)) }));
  }

  ws.on('message', (raw) => {
    const text = raw.toString();
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === 'op') {
      opLog.push(text);
      // Broadcast to all *other* clients.
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(text);
        }
      }
    }
  });
});

console.log(`[crdt-mvp-server] listening on ws://localhost:${PORT}`);
