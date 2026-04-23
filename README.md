# CRDT Collaborative Editor

**Stack:** TypeScript · Vite · React 19 · Yjs-style custom CRDT (RGA then Y.Text-compatible) · `ws` / `uWebSockets.js` server · IndexedDB (idb-keyval) · WebRTC (simple-peer) · ProseMirror for rich text

## Full Vision
Google Docs-grade: rich-text CRDT, multi-cursor presence, offline-first, WebRTC P2P + signaling fallback, version history, permissions, plugin system, 100+ concurrent editors.

## MVP (1 night)
Two browser tabs syncing plaintext via WebSocket using RGA CRDT.

## MVP Status — shipped

The 1-night MVP lives in [`mvp/`](./mvp). Custom RGA CRDT (per-character
`{clientId, lamport}` IDs, tombstone deletes, lamport+clientId tie-break for
concurrent inserts), `ws` relay server, Vite + vanilla-TS client with a
textarea bound to the CRDT.

### Demo
```bash
# terminal 1
cd mvp/server && npm install && npm run server
# terminal 2
cd mvp/client && npm install && npm run dev
```
Open http://localhost:5173 in two tabs and type — edits replicate live.
See [`mvp/README.md`](./mvp/README.md) for details.

## Milestones
- **M1 (Week 1):** RGA plaintext sync across 2 clients via WS
- **M2 (Week 2):** Offline queue + reconnect merge + IndexedDB
- **M3 (Week 4):** Rich text via Y.Text-compatible CRDT + ProseMirror
- **M4 (Week 6):** Presence (cursors, selections) + WebRTC P2P
- **M5 (Week 8):** Version history + permissions + 100-user load test

## Key References
- Yjs internals (Kevin Jahns talks)
- "A Conflict-Free Replicated JSON Datatype" (Kleppmann)
- Automerge docs
