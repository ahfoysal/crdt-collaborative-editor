import { RGA, type Op } from './rga';
import {
  getOrCreateClientId,
  getMeta,
  loadAllOps,
  clearAll,
} from './persistence';
import { SyncClient } from './sync';

// --- boot -----------------------------------------------------------------
// We do a small async boot: clientId + replay from IDB, then wire up the UI.

const editor = document.getElementById('editor') as HTMLTextAreaElement;
const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const clientIdEl = document.getElementById('clientId') as HTMLElement;
const offlineBtn = document.getElementById('offlineBtn') as HTMLButtonElement | null;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement | null;

function setStatus(ok: boolean, text: string) {
  statusDot.className = 'dot ' + (ok ? 'ok' : 'bad');
  statusText.textContent = text;
}

async function boot() {
  const clientId = await getOrCreateClientId();
  clientIdEl.textContent = clientId;

  const rga = new RGA(clientId);

  // 1. Replay the persisted op log into a fresh RGA so the editor shows the
  //    local document state *before* we even hit the network. This is what
  //    makes reloads feel instant and what gives us full offline reads.
  const stored = await loadAllOps();
  const pendingOutbox: Op[] = [];
  for (const entry of stored) {
    rga.applyRemote(entry.op);
    // Any local op that never got a server seq is still in the outbox.
    if (entry.local && entry.seq === undefined) {
      pendingOutbox.push(entry.op);
    }
  }
  const lastSeq = (await getMeta<number>('lastSeq')) ?? 0;

  // 2. Prime the editor from the restored CRDT.
  let lastValue = rga.toString();
  editor.value = lastValue;

  // 3. Wire sync.
  let applyingRemote = false;
  const sync = new SyncClient(
    `ws://${location.hostname}:8787`,
    lastSeq,
    pendingOutbox,
    {
      onStatus: setStatus,
      onRemoteOp: (op) => {
        const changed = rga.applyRemote(op);
        if (changed) renderFromCRDT();
      },
    },
  );
  sync.connect();

  function renderFromCRDT() {
    const next = rga.toString();
    if (next === editor.value) {
      lastValue = next;
      return;
    }
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    const oldVal = editor.value;
    applyingRemote = true;
    editor.value = next;
    lastValue = next;
    const delta = next.length - oldVal.length;
    let i = 0;
    const min = Math.min(next.length, oldVal.length);
    while (i < min && next[i] === oldVal[i]) i++;
    if (i >= selStart) {
      editor.selectionStart = selStart;
      editor.selectionEnd = selEnd;
    } else {
      editor.selectionStart = Math.max(0, selStart + delta);
      editor.selectionEnd = Math.max(0, selEnd + delta);
    }
    applyingRemote = false;
  }

  function diffAndEmit() {
    if (applyingRemote) return;
    const before = lastValue;
    const after = editor.value;
    if (before === after) return;

    let start = 0;
    const min = Math.min(before.length, after.length);
    while (start < min && before[start] === after[start]) start++;
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

    const localOps: Op[] = [];
    if (deletedCount > 0) localOps.push(...rga.localDelete(start, deletedCount));
    if (insertedText.length > 0) localOps.push(...rga.localInsert(start, insertedText));

    for (const op of localOps) {
      // Fire-and-forget; submitLocal persists synchronously before sending.
      void sync.submitLocal(op);
    }

    lastValue = after;
  }

  editor.addEventListener('input', diffAndEmit);

  // Demo controls — let the user toggle the socket to test offline behavior.
  if (offlineBtn) {
    let offline = false;
    offlineBtn.addEventListener('click', () => {
      offline = !offline;
      if (offline) {
        sync.goOffline();
        offlineBtn.textContent = 'Go online';
      } else {
        sync.goOnline();
        offlineBtn.textContent = 'Go offline';
      }
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await clearAll();
      location.reload();
    });
  }
}

boot().catch((err) => {
  console.error('[crdt-mvp] boot failed', err);
  setStatus(false, 'boot failed — see console');
});
