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

## M2 additions — offline + persistence

- **Client IndexedDB persistence** (`client/src/persistence.ts`). Every op the
  client sees — local or remote — is appended to an IDB object store plus a
  `meta` store that tracks the last server-assigned `seq` and a stable
  `clientId`. On boot we replay the log into a fresh RGA before touching the
  network, so reloads and cold starts are instant and fully readable offline.
- **Offline op queue + reconnect merge** (`client/src/sync.ts`). When the WS
  isn't OPEN, local ops are persisted to IDB (marked `local:true`) and buffered
  in an in-memory outbox. On reconnect we send `{type:'hello', lastSeq}` — the
  server streams back every op with a higher seq as a single `sync` — then we
  flush the outbox. Try it: click **Go offline**, type a bunch, click **Go
  online**, watch the queue drain.
- **Server-side durable op log** (`server/src/oplog.ts`). Ops are appended to a
  JSON file (`oplog.json`) with a monotonic per-server `seq`. The log is
  deduplicated by RGA `OpId` (`{c,l}`) so a client retrying the same op after a
  flaky disconnect doesn't get a second seq. Kill and restart the server — the
  next client to connect with `lastSeq=0` gets the full history replayed.

### Tests

```bash
cd mvp/server && npm test    # OpLog dedup + persistence round-trip
cd mvp/client && npm test    # RGA convergence + SyncClient offline/reconnect
```

## Known limitations

- Caret may jump on large remote edits (no cursor-position CRDT yet).
- Plaintext only; no formatting, presence, or WebRTC — those come in M3–M4.
- Op log file grows unbounded; no compaction / snapshotting yet.
