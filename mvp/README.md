# CRDT MVP — RGA Collaborative Plaintext Editor

Two browser tabs, one textarea each, edits replicated in real time via a
custom **Replicated Growable Array (RGA)** CRDT over a WebSocket relay.

## What's here

```
mvp/
  server/   Node + ws relay (TypeScript, run with tsx)
  client/   Vite + vanilla TS; textarea bound to the RGA CRDT
```

- **CRDT:** `client/src/rga.ts` — each character is a node with `{clientId, lamport}`;
  concurrent inserts at the same anchor are tie-broken by `(lamport desc, clientId desc)`.
  Deletes are tombstones.
- **Transport:** the server is dumb — it appends every `op` message to an in-memory log
  and broadcasts it to other clients. New connections receive a `sync` snapshot.
- **Editor binding:** on every `input` event the client diffs old→new textarea value
  down to one delete range + one insert run, produces ops from the RGA, and sends them.

## Run it

Open two terminals.

**Terminal 1 — relay server** (ws://localhost:8787):

```bash
cd mvp/server
npm install
npm run server
```

**Terminal 2 — web client** (http://localhost:5173):

```bash
cd mvp/client
npm install
npm run dev
```

Then open **http://localhost:5173** in two browser tabs. Type in one,
watch the other update. Disconnect/reconnect works — new tabs replay the op log.

## Known MVP limitations

- Op log is in-memory only (lost on server restart).
- Caret may jump on large remote edits (no cursor-position CRDT yet).
- Plaintext only; no formatting, presence, or offline queue — those come in M2–M4.
