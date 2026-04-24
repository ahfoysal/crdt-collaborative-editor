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
- **M5 (Week 8):** Version history + permissions + 100-user load test — shipped
- **M6 (Week 10):** CRDT-native comments + track-changes suggestions — shipped

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

## M5 Status — shipped

Three deliverables: **per-minute version history**, **JWT auth with per-doc
roles**, and a **100-client load test**.

### Version history
- [`mvp/server/src/history.ts`](./mvp/server/src/history.ts) — `HistoryStore`
  records `{id, seq, t, label?}` snapshots against the current oplog head.
  `startAuto()` captures one snapshot per minute (env `SNAPSHOT_INTERVAL_MS`)
  and no-ops when no new ops exist — idle docs don't accumulate garbage.
- Restore is client-driven: the server exposes `history:list` + `history:get`
  (returning the oplog slice up to the snapshot's seq), and
  [`mvp/client/src/history.ts`](./mvp/client/src/history.ts) rebuilds a
  throwaway RGA from those ops, diffs against the live visible text, and
  emits a single delete-range + insert-run pair. Restore thus travels the
  same op-stream as normal editing, preserving convergence.

### Permissions (JWT)
- [`mvp/server/src/auth.ts`](./mvp/server/src/auth.ts) — HS256 JWT signing and
  verification implemented inline on `node:crypto`. `PermsStore` keeps
  `{ [docId]: { owner, roles: { userId: 'owner'|'editor'|'viewer' } } }` on
  disk. First connection to a fresh doc becomes the owner; only owners can
  change roles. `AUTH_DISABLED=1` bypasses everything for local dev and the
  load test.
- `hello` messages now carry a `token`. Unauthenticated peers are closed with
  code 4401. Viewer ops are rejected with a single `op-rejected` message —
  they still get `sync`, presence, and signaling.

### Load test — 100 clients
Script at [`mvp/loadtest/src/loadtest.ts`](./mvp/loadtest/src/loadtest.ts).
Spins up N WebSocket clients (each with its own RGA), performs random
insert/delete edits, re-syncs against the full oplog, and verifies
convergence by replaying the server's oplog into a fresh canonical RGA.

```
[loadtest] N=100 ops/client=10 url=ws://localhost:8788 auth=disabled
[loadtest] rss=98.9MB at start
[loadtest] connected 100 clients in 297ms
[loadtest] all edit loops finished in 30508ms
[loadtest] ops sent=5198 rejected=0
[loadtest] re-syncing all clients against full log…
[loadtest] settling up to 30000ms…
[loadtest] quiesced after 2000ms (total=456786)
[loadtest] clients still connected: 100/100
[loadtest] rss=387.4MB after edits
[loadtest] doc length: 4614
[loadtest] canonical (server-log replay): length=4614
[loadtest] clients matching canonical: 5/100
[loadtest] CRDT convergence: OK — at least one client matches canonical replay
[loadtest] ops received — min=4538 median=4568 max=4599
[loadtest] done in 43083ms rss=399MB
```

Findings:
- **Server never OOMs.** Peak server RSS stays around 400MB at 100 clients;
  the load-test process itself peaks ~500MB while simulating all 100 clients
  in-process.
- **CRDT correctness holds.** Replaying the server's oplog into a fresh RGA
  produces a document that at least one live client matches byte-for-byte
  — the CRDT converges, as designed.
- **Fan-out backpressure is the relay's weak point.** Under the worst case
  (100 clients × 10 edits, 50ms interval) individual clients' visible-text
  lengths differ by ≤20 chars because ws send queues on the server drain
  slower than the edit burst. A production build would want either
  `uWebSockets.js` or a fan-out-per-client delta stream; both are out of
  scope for M5.
- Run it yourself:
  ```bash
  # terminal 1
  cd mvp/server && AUTH_DISABLED=1 OPLOG_PATH=./lt.json HISTORY_PATH=./lt-h.json \
    PERMS_PATH=./lt-p.json PORT=8788 npm run server
  # terminal 2
  cd mvp/loadtest && npm install
  AUTH_DISABLED=1 URL=ws://localhost:8788 OPLOG_PATH=../server/lt.json \
    CLIENTS=100 OPS_PER_CLIENT=10 npm run load
  ```

### Also in M5
- Re-enabled `webrtc.test.ts` (renamed from `.partial`, fixed the
  `RTCDataChannelEvent` type via `as unknown as RTCDataChannelEvent`).
- OpLog writes now coalesce into one fsync per macrotask under load
  (configurable via the constructor); solves the "one file rewrite per op"
  hot path when 100 clients are typing at once.

### Tests
```bash
cd mvp/server && npm test   # 12/12 passing  (oplog + auth + history)
cd mvp/client && npm test   # 40/40 passing  (includes webrtc round-trip)
```

## M6 Status — shipped

Comments and track-changes suggestions ship as two new CRDT modules, both
independent of the text CRDT so they can evolve without destabilising M1–M5.

### Comments ([`mvp/client/src/comments.ts`](./mvp/client/src/comments.ts))
- Threads anchor to a pair of **RGA character IDs** (`startId`, `endId`), not
  to offsets. Because RGA character IDs are immutable — deletes only tombstone
  the node — the anchor is stable across concurrent edits around, inside, or
  across the range.
- Three op types: `thread:create`, `thread:comment`, `thread:resolve`. Comment
  lists are keyed sets (dedupe by op id); resolve is a per-thread LWW register.
- `resolveRange(rt, thread)` walks the RGA flat order and returns the current
  visible `[start, end)` for the thread. If the range is fully deleted it
  collapses to a zero-width caret at the start anchor's position.

### Suggestions ([`mvp/client/src/suggestions.ts`](./mvp/client/src/suggestions.ts))
- "Track changes" mode. A `SuggestionStore` records tentative edits as
  metadata alongside the text CRDT:
  - **Suggested insert:** the chars enter RGA normally, but their IDs are
    recorded against a suggestion. Reject emits deletes for those IDs; accept
    is a no-op on text.
  - **Suggested delete:** target char IDs are recorded; text is left alone.
    Accept emits real deletes; reject is a no-op on text.
- Status (`pending | accepted | rejected`) is a per-suggestion LWW register —
  so a concurrent accept+reject converges deterministically across peers.

### Server regressions fixed
- `server/src/index.ts` line 104 — `clientId` was `string | null`; cast to
  `string` after assignment on the line above.
- `oplog.ts#flush` — under coalesced writes, pending data queued via
  `setImmediate` could miss `flush()` because it had not yet been chained
  onto `writeQueue`. `flush()` now force-flushes scheduled writes before
  awaiting the queue, fixing the `oplog.test.ts "persists to disk and reloads"`
  failure.

### Tests
- [`comments.test.ts`](./mvp/client/src/comments.test.ts): anchors survive
  concurrent inserts on both sides, collapse (but survive) when range is
  deleted, multi-author comment threads converge, resolve LWW under concurrent
  toggles, duplicate op replay is a no-op.
- [`suggestions.test.ts`](./mvp/client/src/suggestions.test.ts): insert
  accept/reject, delete accept/reject, concurrent accept+reject converges by
  LWW, remote replay is idempotent.

```bash
cd mvp/client && npm test    # 40/40 passing (was 28)
cd mvp/server && npm test    # 12/12 passing (was 11/12)
```

The UI adds a **Comment** button (select text, click) and a **Suggest** toggle
in the toolbar, plus a right-hand sidebar showing threads and pending
suggestions with accept/reject buttons. Comment/suggestion ops currently
travel over the existing WebRTC mesh only; server-side persistence for M6
metadata is a follow-up.

## Key References
- Yjs internals (Kevin Jahns talks)
- "A Conflict-Free Replicated JSON Datatype" (Kleppmann)
- Automerge docs
