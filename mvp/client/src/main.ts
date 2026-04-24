/**
 * M3 wiring: RichText CRDT <-> contenteditable div + B/I/U toolbar.
 *
 * The DOM is rendered from the CRDT (`renderFromCRDT`) as a sequence of spans
 * whose tagName encodes the active attributes. Local text edits are captured
 * via `beforeinput` — for each input type we compute a CRDT index range from
 * the current selection, emit the appropriate insert/delete ops, then
 * re-render. Toolbar buttons call `rt.format(...)` on the selected range.
 */
import { RichText, type Op, type Attrs, type OpId, type InsertOp } from './richtext';
import { CommentStore, type CommentOp } from './comments';
import { SuggestionStore, type SuggestionOp } from './suggestions';
import {
  getOrCreateClientId,
  getMeta,
  loadAllOps,
  clearAll,
} from './persistence';
import { SyncClient } from './sync';
import { Presence, type PresenceState } from './presence';
import { WebRtcMesh } from './webrtc';

const editor = document.getElementById('editor') as HTMLElement;
const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const clientIdEl = document.getElementById('clientId') as HTMLElement;
const transportEl = document.getElementById('transport') as HTMLElement | null;
const peersEl = document.getElementById('peers') as HTMLElement | null;
const cursorLayer = document.getElementById('cursorLayer') as HTMLElement | null;
const offlineBtn = document.getElementById('offlineBtn') as HTMLButtonElement | null;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement | null;
const btnBold = document.getElementById('btnBold') as HTMLButtonElement;
const btnItalic = document.getElementById('btnItalic') as HTMLButtonElement;
const btnUnderline = document.getElementById('btnUnderline') as HTMLButtonElement;
const btnComment = document.getElementById('btnComment') as HTMLButtonElement | null;
const btnSuggestMode = document.getElementById('btnSuggestMode') as HTMLButtonElement | null;
const threadsEl = document.getElementById('threads') as HTMLElement | null;
const suggestionsEl = document.getElementById('suggestions') as HTMLElement | null;

function setStatus(ok: boolean, text: string) {
  statusDot.className = 'dot ' + (ok ? 'ok' : 'bad');
  statusText.textContent = text;
}

/** Pending attributes for the next typed char (toolbar toggled at caret). */
const pendingAttrs: Attrs = {};

async function boot() {
  const clientId = await getOrCreateClientId();
  clientIdEl.textContent = clientId;

  const rt = new RichText(clientId);

  // Replay persisted ops before wiring sync.
  const stored = await loadAllOps();
  const pendingOutbox: Op[] = [];
  for (const entry of stored) {
    rt.applyRemote(entry.op as Op);
    if (entry.local && entry.seq === undefined) {
      pendingOutbox.push(entry.op as Op);
    }
  }
  const lastSeq = (await getMeta<number>('lastSeq')) ?? 0;

  renderFromCRDT();

  // Presence + WebRTC (M4). The mesh carries ops peer-to-peer when possible;
  // the server is used for signaling, persistence, and fallback delivery.
  const presence = new Presence(clientId, {
    onBroadcast: (state) => {
      sync.sendPresence(state);
      mesh.broadcastPresence(state);
    },
    onChange: () => renderPresenceOverlay(),
  });

  const mesh = new WebRtcMesh(clientId, {
    onPeerOp: (op) => {
      const changed = rt.applyRemote(op as Op);
      if (changed) renderFromCRDT();
    },
    onPeerPresence: (state) => {
      presence.applyRemote(state as PresenceState);
    },
    onConnectivityChange: (n, ids) => {
      if (transportEl) {
        transportEl.textContent = n > 0
          ? `Connected via P2P (${n} peer${n === 1 ? '' : 's'})`
          : 'Via server';
      }
      if (peersEl) peersEl.textContent = ids.length ? `peers: ${ids.join(', ')}` : '';
    },
    sendSignal: (to, data) => sync.sendSignal(to, data),
  });
  // Initialise transport indicator.
  if (transportEl) transportEl.textContent = 'Via server';

  const sync = new SyncClient(
    `ws://${location.hostname}:8787`,
    lastSeq,
    pendingOutbox as any,
    {
      onStatus: setStatus,
      onRemoteOp: (op) => {
        const changed = rt.applyRemote(op as Op);
        if (changed) renderFromCRDT();
      },
      onPresence: (state) => {
        presence.applyRemote(state as PresenceState);
      },
      onPeers: (peerIds) => {
        void mesh.setPeerList(peerIds);
        // Broadcast our current state so new peers see us.
        presence.broadcastNow();
      },
      onPeerJoin: (peerId) => {
        void mesh.onPeerJoin(peerId);
        presence.broadcastNow();
      },
      onPeerLeave: (peerId) => {
        mesh.onPeerLeave(peerId);
        presence.drop(peerId);
      },
      onSignal: (env) => { void mesh.onSignal(env); },
    },
    clientId,
  );
  sync.connect();

  /** Render the CRDT runs into the contenteditable. */
  function renderFromCRDT(caret?: { start: number; end: number }) {
    const sel = caret ?? getCaretRange();
    editor.innerHTML = '';
    const runs = rt.toRuns();
    for (const run of runs) {
      editor.appendChild(renderRun(run.text, run.attrs));
    }
    if (sel) setCaretRange(sel.start, sel.end);
    syncToolbarState();
    renderPresenceOverlay();
  }

  /**
   * Render remote cursors + selections as absolutely-positioned overlays on
   * top of the editor. Each peer is drawn as a colored caret bar with an
   * optional name label, plus a translucent rect for any selection.
   */
  function renderPresenceOverlay() {
    if (!cursorLayer) return;
    cursorLayer.innerHTML = '';
    const editorRect = editor.getBoundingClientRect();
    const layerRect = cursorLayer.getBoundingClientRect();
    const dx = editorRect.left - layerRect.left;
    const dy = editorRect.top - layerRect.top;

    for (const peer of presence.getRemotes()) {
      if (peer.head == null) continue;
      const start = Math.min(peer.anchor ?? peer.head, peer.head);
      const end = Math.max(peer.anchor ?? peer.head, peer.head);
      // Selection rectangles
      if (end > start) {
        const rects = rectsForRange(start, end);
        for (const r of rects) {
          const box = document.createElement('div');
          box.className = 'remote-selection';
          box.style.left = `${r.left - editorRect.left + dx}px`;
          box.style.top = `${r.top - editorRect.top + dy}px`;
          box.style.width = `${r.width}px`;
          box.style.height = `${r.height}px`;
          box.style.background = peer.color;
          box.style.opacity = '0.25';
          cursorLayer.appendChild(box);
        }
      }
      // Caret
      const caret = rectForOffset(peer.head);
      if (!caret) continue;
      const bar = document.createElement('div');
      bar.className = 'remote-caret';
      bar.style.left = `${caret.left - editorRect.left + dx}px`;
      bar.style.top = `${caret.top - editorRect.top + dy}px`;
      bar.style.height = `${caret.height}px`;
      bar.style.background = peer.color;
      const label = document.createElement('span');
      label.className = 'remote-caret-label';
      label.textContent = peer.name;
      label.style.background = peer.color;
      bar.appendChild(label);
      cursorLayer.appendChild(bar);
    }
  }

  /** Viewport-relative rect for the visible character at offset (zero-width). */
  function rectForOffset(offset: number): DOMRect | null {
    const pos = locate(offset);
    if (!pos) return null;
    const range = document.createRange();
    try {
      range.setStart(pos.node, pos.offset);
      range.setEnd(pos.node, pos.offset);
    } catch { return null; }
    const rects = range.getClientRects();
    if (rects.length > 0) return rects[0];
    // Collapsed ranges in empty elements return no rects — fall back to
    // the editor's own bounding box for a top-left caret.
    const r = editor.getBoundingClientRect();
    return new DOMRect(r.left + 4, r.top + 4, 0, 16);
  }

  function rectsForRange(start: number, end: number): DOMRectList | DOMRect[] {
    const s = locate(start);
    const e = locate(end);
    if (!s || !e) return [];
    const range = document.createRange();
    try {
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
    } catch { return []; }
    return range.getClientRects();
  }

  function emitOps(ops: Op[]) {
    for (const op of ops) void sync.submitLocal(op as any);
  }

  // --- input handling -----------------------------------------------------

  editor.addEventListener('beforeinput', (ev: InputEvent) => {
    const range = getCaretRange();
    if (!range) return;
    const { start, end } = range;

    const type = ev.inputType;
    // Insertions
    if (type === 'insertText' || type === 'insertCompositionText' || type === 'insertReplacementText') {
      ev.preventDefault();
      const text = ev.data ?? '';
      const ops: Op[] = [];
      if (end > start) ops.push(...rt.localDelete(start, end - start));
      // Inherit attrs: either pending-toolbar state, or attrs of char at caret.
      const attrs = resolveInsertAttrs(rt, start);
      if (text.length > 0) ops.push(...rt.localInsert(start, text, attrs));
      emitOps(ops);
      (window as any).__onLocalInsert?.(ops);
      const newCaret = start + text.length;
      renderFromCRDT({ start: newCaret, end: newCaret });
      return;
    }
    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      ev.preventDefault();
      const ops: Op[] = [];
      if (end > start) ops.push(...rt.localDelete(start, end - start));
      const attrs = resolveInsertAttrs(rt, start);
      ops.push(...rt.localInsert(start, '\n', attrs));
      emitOps(ops);
      const newCaret = start + 1;
      renderFromCRDT({ start: newCaret, end: newCaret });
      return;
    }

    // Deletions
    if (type.startsWith('delete')) {
      ev.preventDefault();
      let delStart = start;
      let delEnd = end;
      if (delStart === delEnd) {
        if (type === 'deleteContentBackward') {
          if (delStart === 0) return;
          delStart -= 1;
        } else if (type === 'deleteContentForward') {
          const len = rt.toString().length;
          if (delEnd >= len) return;
          delEnd += 1;
        } else {
          return;
        }
      }
      // Suggestion mode: record a suggest-delete instead of deleting.
      const intercepted = (window as any).__interceptLocalDelete?.(delStart, delEnd);
      if (intercepted) {
        renderFromCRDT({ start: delEnd, end: delEnd });
        return;
      }
      const ops = rt.localDelete(delStart, delEnd - delStart);
      emitOps(ops);
      renderFromCRDT({ start: delStart, end: delStart });
      return;
    }

    // Anything else — cancel to keep DOM/CRDT in sync.
    ev.preventDefault();
  });

  // Paste as plain text.
  editor.addEventListener('paste', (ev: ClipboardEvent) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    const range = getCaretRange();
    if (!range) return;
    const ops: Op[] = [];
    if (range.end > range.start) ops.push(...rt.localDelete(range.start, range.end - range.start));
    const attrs = resolveInsertAttrs(rt, range.start);
    ops.push(...rt.localInsert(range.start, text, attrs));
    emitOps(ops);
    const newCaret = range.start + text.length;
    renderFromCRDT({ start: newCaret, end: newCaret });
  });

  // --- toolbar ------------------------------------------------------------

  function applyToolbar(key: 'bold' | 'italic' | 'underline') {
    const range = getCaretRange();
    if (!range) return;
    if (range.start === range.end) {
      // No selection — toggle the "pending" attribute for next typed char.
      pendingAttrs[key] = !pendingAttrs[key];
      syncToolbarState();
      return;
    }
    // Determine next value: if any char in range lacks it, turn on; else off.
    const value = !rangeHasAttr(rt, range.start, range.end, key);
    const ops = rt.format(range.start, range.end, { [key]: value });
    emitOps(ops);
    renderFromCRDT(range);
  }

  btnBold.addEventListener('mousedown', (e) => e.preventDefault());
  btnItalic.addEventListener('mousedown', (e) => e.preventDefault());
  btnUnderline.addEventListener('mousedown', (e) => e.preventDefault());
  btnBold.addEventListener('click', () => applyToolbar('bold'));
  btnItalic.addEventListener('click', () => applyToolbar('italic'));
  btnUnderline.addEventListener('click', () => applyToolbar('underline'));

  editor.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); applyToolbar('bold'); }
    else if (k === 'i') { e.preventDefault(); applyToolbar('italic'); }
    else if (k === 'u') { e.preventDefault(); applyToolbar('underline'); }
  });

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) syncToolbarState();
  });

  function syncToolbarState() {
    const range = getCaretRange();
    if (!range) return;
    const attrs = range.start === range.end
      ? { ...rt.attrsAt(Math.max(0, range.start - 1)), ...pendingAttrs }
      : rangeAttrs(rt, range.start, range.end);
    btnBold.classList.toggle('active', !!attrs.bold);
    btnItalic.classList.toggle('active', !!attrs.italic);
    btnUnderline.classList.toggle('active', !!attrs.underline);
  }

  // --- M6: Comments + Suggestions ---------------------------------------
  // For the MVP, comment/suggestion ops travel over the existing WebRTC mesh
  // only (no server persistence for M6 metadata yet). Reloading loses threads;
  // peers who connect while you're already commenting will see new ops in
  // real time. This keeps server deltas minimal while the CRDT semantics
  // (tested independently) are the load-bearing part.
  const comments = new CommentStore(clientId);
  const suggestions = new SuggestionStore(clientId);
  let suggestMode = false;

  function broadcastMeta(kind: 'comment' | 'suggestion', op: CommentOp | SuggestionOp) {
    // Reuse the mesh's op broadcast channel with a wrapped envelope.
    // Other peers route unknown-type ops to the meta handler via onPeerOp.
    mesh.broadcastOp({ __meta: kind, op });
  }

  // Intercept mesh peer ops for meta envelopes. (We leave the text path alone;
  // the existing onPeerOp continues to handle standard text ops.)
  const origOnPeerOp = (m: any) => {
    if (m && typeof m === 'object' && m.__meta === 'comment') {
      if (comments.applyRemote(m.op as CommentOp)) renderSidebar();
      return true;
    }
    if (m && typeof m === 'object' && m.__meta === 'suggestion') {
      if (suggestions.applyRemote(m.op as SuggestionOp)) {
        renderFromCRDT();
        renderSidebar();
      }
      return true;
    }
    return false;
  };
  // Monkey-patch mesh's op callback to filter meta envelopes first.
  const prevCb = (mesh as any).events?.onPeerOp as ((op: unknown, from: string) => void) | undefined;
  if (prevCb) {
    (mesh as any).events.onPeerOp = (op: unknown, from: string) => {
      if (origOnPeerOp(op)) return;
      prevCb(op, from);
    };
  }

  function renderSidebar() {
    if (threadsEl) {
      const list = comments.listThreads();
      if (list.length === 0) {
        threadsEl.className = 'empty';
        threadsEl.textContent = 'No threads yet. Select text and click Comment.';
      } else {
        threadsEl.className = '';
        threadsEl.innerHTML = '';
        for (const t of list) {
          const div = document.createElement('div');
          div.className = 'thread' + (t.resolved ? ' resolved' : '');
          const range = comments.resolveRange(rt, t);
          const rangeText = range ? `${range.start}–${range.end}` : '?';
          const head = document.createElement('div');
          head.className = 'range';
          head.textContent = `range ${rangeText} · ${t.createdBy}`;
          div.appendChild(head);
          for (const c of t.comments) {
            const cd = document.createElement('div');
            cd.className = 'comment';
            cd.innerHTML = `<span class="author"></span> <span class="body"></span>`;
            cd.querySelector('.author')!.textContent = c.authorId;
            cd.querySelector('.body')!.textContent = c.text;
            div.appendChild(cd);
          }
          const form = document.createElement('form');
          const input = document.createElement('input');
          input.placeholder = 'Reply…';
          const resolveBtn = document.createElement('button');
          resolveBtn.type = 'button';
          resolveBtn.textContent = t.resolved ? 'Reopen' : 'Resolve';
          resolveBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const op = comments.localSetResolved(t.id, !t.resolved, clientId);
            broadcastMeta('comment', op);
            renderSidebar();
          });
          form.appendChild(input);
          form.appendChild(resolveBtn);
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            const op = comments.localAddComment(t.id, clientId, text);
            broadcastMeta('comment', op);
            input.value = '';
            renderSidebar();
          });
          div.appendChild(form);
          threadsEl.appendChild(div);
        }
      }
    }
    if (suggestionsEl) {
      const list = suggestions.list();
      if (list.length === 0) {
        suggestionsEl.className = 'empty';
        suggestionsEl.textContent = 'Toggle Suggest to record tentative edits.';
      } else {
        suggestionsEl.className = '';
        suggestionsEl.innerHTML = '';
        for (const s of list) {
          const div = document.createElement('div');
          div.className = 'thread';
          const hd = document.createElement('div');
          hd.className = 'range';
          hd.textContent = `${s.kind} · ${s.authorId} · ${s.status}`;
          div.appendChild(hd);
          if (s.status === 'pending') {
            const accept = document.createElement('button');
            accept.type = 'button';
            accept.textContent = 'Accept';
            accept.addEventListener('click', () => {
              const { status, textOps } = suggestions.localAccept(s.id, clientId);
              for (const op of textOps) void sync.submitLocal(op as any);
              for (const op of textOps) rt.applyRemote(op);
              broadcastMeta('suggestion', status);
              renderFromCRDT();
              renderSidebar();
            });
            const reject = document.createElement('button');
            reject.type = 'button';
            reject.textContent = 'Reject';
            reject.addEventListener('click', () => {
              const { status, textOps } = suggestions.localReject(s.id, clientId);
              for (const op of textOps) void sync.submitLocal(op as any);
              for (const op of textOps) rt.applyRemote(op);
              broadcastMeta('suggestion', status);
              renderFromCRDT();
              renderSidebar();
            });
            div.appendChild(accept);
            div.appendChild(reject);
          }
          suggestionsEl.appendChild(div);
        }
      }
    }
  }

  // Button: create a comment thread anchored to the current selection.
  if (btnComment) {
    btnComment.addEventListener('mousedown', (e) => e.preventDefault());
    btnComment.addEventListener('click', () => {
      const range = getCaretRange();
      if (!range || range.start === range.end) {
        alert('Select some text first');
        return;
      }
      const visible = rt.visibleNodes();
      const startId: OpId | undefined = visible[range.start]?.id;
      const endId: OpId | undefined = visible[range.end - 1]?.id;
      if (!startId || !endId) return;
      const op = comments.localCreateThread(startId, endId, clientId);
      broadcastMeta('comment', op);
      const text = prompt('Comment:');
      if (text && text.trim()) {
        const cOp = comments.localAddComment(op.id, clientId, text.trim());
        broadcastMeta('comment', cOp);
      }
      renderSidebar();
    });
  }

  // Button: toggle suggestion mode. When on, the next localInsert ops are
  // recorded as suggestions, and delete of a selection becomes a
  // suggest-delete (no real deletion until accepted).
  if (btnSuggestMode) {
    btnSuggestMode.addEventListener('click', () => {
      suggestMode = !suggestMode;
      btnSuggestMode.classList.toggle('mode-on', suggestMode);
      btnSuggestMode.textContent = suggestMode ? 'Suggest (on)' : 'Suggest';
    });
  }

  // Expose suggestion hook so the input handler can record inserted-char IDs.
  (window as any).__onLocalInsert = (ops: Op[]) => {
    if (!suggestMode) return;
    const ids = ops.flatMap((o) => (o.type === 'insert' ? [(o as InsertOp).id] : []));
    if (ids.length === 0) return;
    const op = suggestions.localSuggestInsert(ids, clientId);
    broadcastMeta('suggestion', op);
    renderSidebar();
  };
  (window as any).__interceptLocalDelete = (start: number, end: number): boolean => {
    if (!suggestMode || end <= start) return false;
    const visible = rt.visibleNodes();
    const ids: OpId[] = [];
    for (let i = start; i < end; i++) if (visible[i]) ids.push(visible[i].id);
    if (ids.length === 0) return false;
    const op = suggestions.localSuggestDelete(ids, clientId);
    broadcastMeta('suggestion', op);
    renderSidebar();
    return true;
  };

  renderSidebar();

  // Demo controls
  if (offlineBtn) {
    let offline = false;
    offlineBtn.addEventListener('click', () => {
      offline = !offline;
      if (offline) { sync.goOffline(); offlineBtn.textContent = 'Go online'; }
      else { sync.goOnline(); offlineBtn.textContent = 'Go offline'; }
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await clearAll();
      location.reload();
    });
  }
}

// --- helpers --------------------------------------------------------------

function renderRun(text: string, attrs: Attrs): Node {
  // Wrap text in u > i > b as needed (nested tags — any order converges).
  let node: Node = document.createTextNode(text);
  if (attrs.bold) { const b = document.createElement('b'); b.appendChild(node); node = b; }
  if (attrs.italic) { const i = document.createElement('i'); i.appendChild(node); node = i; }
  if (attrs.underline) { const u = document.createElement('u'); u.appendChild(node); node = u; }
  // Wrap bare text in a span for consistent text-node traversal.
  if (node.nodeType === Node.TEXT_NODE) {
    const span = document.createElement('span');
    span.appendChild(node);
    return span;
  }
  return node;
}

function resolveInsertAttrs(rt: RichText, index: number): Attrs | undefined {
  if (Object.keys(pendingAttrs).length > 0) {
    const out: Attrs = {};
    // Start from attrs just before the caret, overlaid with pending toggles.
    const base = index > 0 ? rt.attrsAt(index - 1) : {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(pendingAttrs)])) {
      const v = pendingAttrs[k] !== undefined ? pendingAttrs[k] : base[k];
      if (v) out[k] = true;
    }
    return out;
  }
  const prev = index > 0 ? rt.attrsAt(index - 1) : {};
  return Object.keys(prev).length ? prev : undefined;
}

function rangeHasAttr(rt: RichText, start: number, end: number, key: string): boolean {
  for (let i = start; i < end; i++) {
    if (!rt.attrsAt(i)[key]) return false;
  }
  return true;
}

function rangeAttrs(rt: RichText, start: number, end: number): Attrs {
  const keys = new Set<string>();
  for (let i = start; i < end; i++) {
    for (const k of Object.keys(rt.attrsAt(i))) keys.add(k);
  }
  const out: Attrs = {};
  for (const k of keys) if (rangeHasAttr(rt, start, end, k)) out[k] = true;
  return out;
}

/** Map the current browser Selection into CRDT text offsets. */
function getCaretRange(): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer) && range.startContainer !== editor) return null;
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  if (start === -1 || end === -1) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Count visible text offset preceding (node, offset) inside #editor. */
function offsetOf(node: Node, offset: number): number {
  if (node === editor) {
    // offset counts children; sum text length of children up to that index.
    let n = 0;
    for (let i = 0; i < offset && i < editor.childNodes.length; i++) {
      n += textLengthOf(editor.childNodes[i]);
    }
    return n;
  }
  let total = 0;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const tn = walker.currentNode;
    if (tn === node) return total + offset;
    total += (tn.nodeValue ?? '').length;
  }
  // Node might be an element — count by traversing its descendants.
  if (node.nodeType === Node.ELEMENT_NODE) {
    let acc = 0;
    const w2 = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (w2.nextNode()) {
      const tn = w2.currentNode;
      if (node.contains(tn)) break;
      acc += (tn.nodeValue ?? '').length;
    }
    // add partial offset of children preceding within the element
    let inside = 0;
    for (let i = 0; i < offset && i < node.childNodes.length; i++) {
      inside += textLengthOf(node.childNodes[i]);
    }
    return acc + inside;
  }
  return -1;
}

function textLengthOf(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.nodeValue ?? '').length;
  let acc = 0;
  const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) acc += (w.currentNode.nodeValue ?? '').length;
  return acc;
}

/** Place the browser caret at the given CRDT text offset(s). */
function setCaretRange(start: number, end: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const startPos = locate(start);
  const endPos = start === end ? startPos : locate(end);
  if (!startPos || !endPos) return;
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

function locate(offset: number): { node: Node; offset: number } | null {
  let remaining = offset;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  while (walker.nextNode()) {
    const tn = walker.currentNode as Text;
    last = tn;
    const len = (tn.nodeValue ?? '').length;
    if (remaining <= len) return { node: tn, offset: remaining };
    remaining -= len;
  }
  if (last) return { node: last, offset: (last.nodeValue ?? '').length };
  return { node: editor, offset: 0 };
}

boot().catch((err) => {
  console.error('[crdt-mvp] boot failed', err);
  setStatus(false, 'boot failed — see console');
});
