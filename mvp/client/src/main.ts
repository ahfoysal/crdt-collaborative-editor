/**
 * M3 wiring: RichText CRDT <-> contenteditable div + B/I/U toolbar.
 *
 * The DOM is rendered from the CRDT (`renderFromCRDT`) as a sequence of spans
 * whose tagName encodes the active attributes. Local text edits are captured
 * via `beforeinput` — for each input type we compute a CRDT index range from
 * the current selection, emit the appropriate insert/delete ops, then
 * re-render. Toolbar buttons call `rt.format(...)` on the selected range.
 */
import { RichText, type Op, type Attrs } from './richtext';
import {
  getOrCreateClientId,
  getMeta,
  loadAllOps,
  clearAll,
} from './persistence';
import { SyncClient } from './sync';

const editor = document.getElementById('editor') as HTMLElement;
const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const clientIdEl = document.getElementById('clientId') as HTMLElement;
const offlineBtn = document.getElementById('offlineBtn') as HTMLButtonElement | null;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement | null;
const btnBold = document.getElementById('btnBold') as HTMLButtonElement;
const btnItalic = document.getElementById('btnItalic') as HTMLButtonElement;
const btnUnderline = document.getElementById('btnUnderline') as HTMLButtonElement;

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
    },
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
