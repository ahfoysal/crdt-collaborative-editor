/**
 * Presence (M4): ephemeral per-client awareness — name, color, cursor anchor +
 * head (plain text offsets for now). Presence state is NEVER persisted to the
 * oplog; it's broadcast over WebSocket (and optionally P2P) as `presence`
 * messages and forgotten on disconnect.
 *
 * A client:
 *  - Publishes its local state via `setLocal(state)`; a throttled broadcast
 *    pushes it onto whatever transport(s) are wired via `onBroadcast`.
 *  - Receives remote states via `applyRemote(state)` and emits `onChange` so
 *    the UI can render colored cursors / selections.
 *  - Drops a peer via `drop(clientId)` when the server announces departure.
 *
 * State is purely LWW: each update carries a monotonic `ts` per clientId; an
 * older ts is ignored. There is no convergence problem — presence is
 * ephemeral — so LWW by wall clock is sufficient.
 */

export type PresenceState = {
  clientId: string;
  name: string;
  color: string;
  /** Plaintext offset of selection anchor (where selection began). */
  anchor: number | null;
  /** Plaintext offset of selection head (caret). */
  head: number | null;
  /** Monotonic per-client timestamp (ms). */
  ts: number;
};

export type PresenceEvents = {
  onChange: (all: PresenceState[]) => void;
  onBroadcast: (state: PresenceState) => void;
};

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
];

export function colorFor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function nameFor(clientId: string): string {
  return `user-${clientId.slice(0, 4)}`;
}

export class Presence {
  private readonly clientId: string;
  private readonly events: PresenceEvents;
  private readonly remote = new Map<string, PresenceState>();
  private local: PresenceState;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcastAt = 0;
  /** Min ms between broadcasts; bursts coalesce. */
  private readonly throttleMs: number;

  constructor(
    clientId: string,
    events: PresenceEvents,
    opts: { name?: string; color?: string; throttleMs?: number } = {},
  ) {
    this.clientId = clientId;
    this.events = events;
    this.throttleMs = opts.throttleMs ?? 40;
    this.local = {
      clientId,
      name: opts.name ?? nameFor(clientId),
      color: opts.color ?? colorFor(clientId),
      anchor: null,
      head: null,
      ts: 0,
    };
  }

  getLocal(): PresenceState {
    return { ...this.local };
  }

  /** List of known peer states (excludes self). */
  getRemotes(): PresenceState[] {
    return [...this.remote.values()];
  }

  /** Update local cursor/selection; triggers a (throttled) broadcast. */
  setLocal(update: Partial<Pick<PresenceState, 'anchor' | 'head' | 'name' | 'color'>>): void {
    const next: PresenceState = { ...this.local, ...update, ts: Date.now() };
    // Skip no-op updates.
    if (
      next.anchor === this.local.anchor &&
      next.head === this.local.head &&
      next.name === this.local.name &&
      next.color === this.local.color
    ) {
      return;
    }
    this.local = next;
    this.scheduleBroadcast();
  }

  /** Apply a remote presence state (LWW by ts). Ignores self. */
  applyRemote(state: PresenceState): boolean {
    if (!state || typeof state.clientId !== 'string') return false;
    if (state.clientId === this.clientId) return false;
    const prev = this.remote.get(state.clientId);
    if (prev && prev.ts >= state.ts) return false;
    this.remote.set(state.clientId, { ...state });
    this.emitChange();
    return true;
  }

  /** Remove a peer (e.g. on disconnect notification). */
  drop(clientId: string): boolean {
    if (!this.remote.delete(clientId)) return false;
    this.emitChange();
    return true;
  }

  /** Clear all remote peers. */
  reset(): void {
    if (this.remote.size === 0) return;
    this.remote.clear();
    this.emitChange();
  }

  /** Force an immediate broadcast (e.g. on (re)connect so new peers see us). */
  broadcastNow(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.lastBroadcastAt = Date.now();
    this.events.onBroadcast({ ...this.local, ts: Date.now() });
  }

  private scheduleBroadcast(): void {
    const now = Date.now();
    const sinceLast = now - this.lastBroadcastAt;
    if (sinceLast >= this.throttleMs) {
      this.broadcastNow();
      return;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, this.throttleMs - sinceLast);
  }

  private emitChange(): void {
    this.events.onChange(this.getRemotes());
  }
}
