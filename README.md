# 04 — CRDT Collaborative Editor

**Stack:** TypeScript · Vite · React 19 · Yjs-style custom CRDT (RGA then Y.Text-compatible) · `ws` / `uWebSockets.js` server · IndexedDB (idb-keyval) · WebRTC (simple-peer) · ProseMirror for rich text

## Full Vision
Google Docs-grade: rich-text CRDT, multi-cursor presence, offline-first, WebRTC P2P + signaling fallback, version history, permissions, plugin system, 100+ concurrent editors.

## MVP (1 night)
Two browser tabs syncing plaintext via WebSocket using RGA CRDT.

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
