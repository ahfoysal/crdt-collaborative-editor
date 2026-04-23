import { RGA, type Op } from './rga';

// --- setup ----------------------------------------------------------------

const clientId = Math.random().toString(36).slice(2, 8);
const rga = new RGA(clientId);

const editor = document.getElementById('editor') as HTMLTextAreaElement;
const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
(document.getElementById('clientId') as HTMLElement).textContent = clientId;

// --- websocket ------------------------------------------------------------

const WS_URL = `ws://${location.hostname}:8787`;
let ws: WebSocket;
let applyingRemote = false;

function setStatus(ok: boolean, text: string) {
  statusDot.className = 'dot ' + (ok ? 'ok' : 'bad');
  statusText.textContent = text;
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => setStatus(true, 'connected');
  ws.onclose = () => {
    setStatus(false, 'disconnected — reconnecting…');
    setTimeout(connect, 1000);
  };
  ws.onerror = () => setStatus(false, 'error');
  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'sync' && Array.isArray(msg.ops)) {
      for (const inner of msg.ops) {
        if (inner && inner.type === 'op' && inner.op) rga.applyRemote(inner.op as Op);
      }
      renderFromCRDT();
    } else if (msg.type === 'op' && msg.op) {
      const changed = rga.applyRemote(msg.op as Op);
      if (changed) renderFromCRDT();
    }
  };
}
connect();

function send(op: Op) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'op', op }));
  }
}

// --- editor binding -------------------------------------------------------

let lastValue = '';

function renderFromCRDT() {
  const next = rga.toString();
  if (next === editor.value) {
    lastValue = next;
    return;
  }
  // Preserve caret as best we can by diffing old/new around current caret.
  const selStart = editor.selectionStart;
  const selEnd = editor.selectionEnd;
  const oldVal = editor.value;
  applyingRemote = true;
  editor.value = next;
  lastValue = next;
  // Adjust caret: if the remote change was entirely before caret, shift by len delta.
  const delta = next.length - oldVal.length;
  // Find common prefix to know where divergence starts.
  let i = 0;
  const min = Math.min(next.length, oldVal.length);
  while (i < min && next[i] === oldVal[i]) i++;
  if (i >= selStart) {
    // change happened at/after caret → keep caret
    editor.selectionStart = selStart;
    editor.selectionEnd = selEnd;
  } else {
    editor.selectionStart = Math.max(0, selStart + delta);
    editor.selectionEnd = Math.max(0, selEnd + delta);
  }
  applyingRemote = false;
}

/**
 * Diff `lastValue` → `editor.value` down to one contiguous replace
 * (delete a range, then insert a run) — sufficient for single-key edits,
 * paste, and most IME commits.
 */
function diffAndEmit() {
  if (applyingRemote) return;
  const before = lastValue;
  const after = editor.value;
  if (before === after) return;

  // Common prefix
  let start = 0;
  const min = Math.min(before.length, after.length);
  while (start < min && before[start] === after[start]) start++;
  // Common suffix
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }

  const deletedCount = endBefore - start;
  const insertedText = after.slice(start, endAfter);

  if (deletedCount > 0) {
    const ops = rga.localDelete(start, deletedCount);
    for (const op of ops) send(op);
  }
  if (insertedText.length > 0) {
    const ops = rga.localInsert(start, insertedText);
    for (const op of ops) send(op);
  }

  lastValue = after;
}

editor.addEventListener('input', diffAndEmit);
