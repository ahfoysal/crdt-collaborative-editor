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
- **M1 (Week 1):** RGA plaintext sync across 2 clients via WS — shipped
- **M2 (Week 2):** Offline queue + reconnect merge + IndexedDB — shipped
- **M3 (Week 4):** Rich text via Y.Text-compatible CRDT + contenteditable — shipped
- **M4 (Week 6):** Presence (cursors, selections) + WebRTC P2P
- **M5 (Week 8):** Version history + permissions + 100-user load test

## M3 Status — shipped

Rich text lands via [`mvp/client/src/richtext.ts`](./mvp/client/src/richtext.ts),
a Y.Text-style CRDT that keeps the RGA character ordering from M1 and adds
per-character `attributes` (bold / italic / underline, extensible). Formatting
is its own op type:

- `InsertOp` carries an optional `attributes` snapshot, so chars typed inside a
  bolded run are born bold.
- `FormatOp { id, targets, key, value }` stamps a single `(key, value)` pair
  across a list of character IDs. Conflicts on the same `(nodeId, key)` resolve
  via last-writer-wins: higher lamport wins, tie-break by higher `clientId`.
  Different keys live in independent registers, so concurrent bold + italic
  on the same range both stick.
- `format(start, end, attrs)` maps a visible range to character IDs and emits
  one `FormatOp` per attribute key. Format ops are idempotent and commutative.

The UI in [`main.ts`](./mvp/client/src/main.ts) replaces the `<textarea>` with
a `contenteditable` div rendered from `rt.toRuns()` as nested `<b>/<i>/<u>`
spans. A toolbar (Bold / Italic / Underline, plus `Ctrl/Cmd+B/I/U`) calls
`rt.format(...)` on the current selection; toggling with no selection stages
`pendingAttrs` for the next typed character. All input flows through
`beforeinput` so the CRDT stays authoritative and the DOM is re-rendered
from runs.

Tests in [`richtext.test.ts`](./mvp/client/src/richtext.test.ts) cover
concurrent conflicting format ops on the same key (LWW convergence),
concurrent format on different keys (both stick), format + insert interleave,
insert attribute inheritance, format idempotency, and format-survives-delete.

```bash
cd mvp/client && npm install && npm test    # 17/17 passing
cd mvp/client && npm run dev                 # live demo (server on :8787)
```

## Key References
- Yjs internals (Kevin Jahns talks)
- "A Conflict-Free Replicated JSON Datatype" (Kleppmann)
- Automerge docs
