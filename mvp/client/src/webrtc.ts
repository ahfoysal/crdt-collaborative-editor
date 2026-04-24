/**
 * WebRTC P2P mesh (M4).
 *
 * Each client maintains one `RTCPeerConnection` per known remote client.
 * The server acts as a signaling channel: it routes `signal` envelopes
 * between clientIds, and announces peer join/leave via `peers` and
 * `peer-leave` messages.
 *
 * Glare resolution: the client with the lexicographically smaller clientId
 * is the *initiator* for a given pair (creates the offer + the ordered data
 * channel). This deterministic rule avoids offer/offer collisions.
 *
 * Once a data channel is open, local ops can be pushed to that peer with
 * very low latency; the caller is still responsible for sending the op to
 * the server over WebSocket so the op is persisted + fanned out to any
 * peer whose RTC channel failed (server-relay fallback). The status
 * indicator ("Connected via P2P" / "Via server") surfaces whether at least
 * one peer channel is open.
 *
 * The class is transport-agnostic for signaling — the embedder supplies
 * `sendSignal(to, data)` which in practice wraps the WebSocket send.
 *
 * For testability, `RTCPeerConnection` is injected via `rtcFactory`.
 */

export type SignalEnvelope = {
  from: string;
  to: string;
  data: unknown;
};

export type RtcEvents = {
  /** An op arrived from a peer over a data channel. */
  onPeerOp: (op: unknown, fromClientId: string) => void;
  /** A presence update arrived from a peer over a data channel. */
  onPeerPresence?: (state: unknown, fromClientId: string) => void;
  /** Called whenever the set of open P2P channels changes. */
  onConnectivityChange: (openPeerCount: number, peerIds: string[]) => void;
  /** Send a signaling payload to a specific peer (via the server). */
  sendSignal: (to: string, data: unknown) => void;
};

type RtcFactory = (config?: RTCConfiguration) => RTCPeerConnection;

interface PeerEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  open: boolean;
  /** True when we created the offer. */
  initiator: boolean;
  /** Queued messages waiting for the channel to open. */
  queue: string[];
}

const DEFAULT_ICE: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export class WebRtcMesh {
  private readonly clientId: string;
  private readonly events: RtcEvents;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly rtcFactory: RtcFactory;
  private readonly config: RTCConfiguration;

  constructor(
    clientId: string,
    events: RtcEvents,
    opts: { rtcFactory?: RtcFactory; config?: RTCConfiguration } = {},
  ) {
    this.clientId = clientId;
    this.events = events;
    this.config = opts.config ?? DEFAULT_ICE;
    this.rtcFactory =
      opts.rtcFactory ??
      ((c?: RTCConfiguration) =>
        new (globalThis as any).RTCPeerConnection(c) as RTCPeerConnection);
  }

  /** True if at least one peer has an open data channel. */
  get hasOpenPeer(): boolean {
    for (const p of this.peers.values()) if (p.open) return true;
    return false;
  }

  /** List of peer clientIds with an open channel. */
  openPeerIds(): string[] {
    const out: string[] = [];
    for (const [id, p] of this.peers) if (p.open) out.push(id);
    return out;
  }

  /** Called when the signaling layer tells us about the current peer list. */
  async setPeerList(peerIds: string[]): Promise<void> {
    const known = new Set(peerIds);
    // Drop peers that left.
    for (const id of [...this.peers.keys()]) {
      if (!known.has(id)) this.disconnect(id);
    }
    // Dial any new peers where we're the initiator.
    for (const id of peerIds) {
      if (id === this.clientId) continue;
      if (this.peers.has(id)) continue;
      if (this.amInitiator(id)) {
        await this.dial(id);
      } else {
        // Pre-create a responder entry so an incoming offer has a home.
        this.ensurePeer(id, /*initiator*/ false);
      }
    }
  }

  /** A remote peer joined after us. */
  async onPeerJoin(peerId: string): Promise<void> {
    if (peerId === this.clientId) return;
    if (this.peers.has(peerId)) return;
    if (this.amInitiator(peerId)) await this.dial(peerId);
    else this.ensurePeer(peerId, false);
  }

  onPeerLeave(peerId: string): void {
    this.disconnect(peerId);
  }

  /** Inbound signaling message routed to us. */
  async onSignal(env: SignalEnvelope): Promise<void> {
    if (env.to !== this.clientId) return;
    const peerId = env.from;
    if (peerId === this.clientId) return;
    const data: any = env.data;
    const entry = this.ensurePeer(peerId, /*initiator*/ this.amInitiator(peerId));
    try {
      if (data?.sdp) {
        await entry.pc.setRemoteDescription(data);
        if (data.type === 'offer') {
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          this.events.sendSignal(peerId, entry.pc.localDescription);
        }
      } else if (data?.candidate !== undefined) {
        try {
          await entry.pc.addIceCandidate(data);
        } catch {
          /* benign: candidate may arrive before remote description */
        }
      }
    } catch (err) {
      // Hard failure — tear down so server-relay kicks in.
      console.warn('[webrtc] signal error', err);
      this.disconnect(peerId);
    }
  }

  /** Broadcast an op to every connected peer. Returns # of peers it reached. */
  broadcastOp(op: unknown): number {
    return this.sendToAll({ type: 'op', op });
  }

  /** Broadcast a presence update to every connected peer. */
  broadcastPresence(state: unknown): number {
    return this.sendToAll({ type: 'presence', state });
  }

  /** Tear everything down. */
  close(): void {
    for (const id of [...this.peers.keys()]) this.disconnect(id);
  }

  // -- internals -----------------------------------------------------------

  private amInitiator(peerId: string): boolean {
    return this.clientId < peerId;
  }

  private ensurePeer(peerId: string, initiator: boolean): PeerEntry {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const pc = this.rtcFactory(this.config);
    const entry: PeerEntry = {
      pc,
      dc: null,
      open: false,
      initiator,
      queue: [],
    };
    this.peers.set(peerId, entry);

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        this.events.sendSignal(peerId, ev.candidate.toJSON());
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        this.disconnect(peerId);
      }
    };
    if (!initiator) {
      pc.ondatachannel = (ev: RTCDataChannelEvent) => {
        this.attachDataChannel(peerId, entry, ev.channel);
      };
    }
    return entry;
  }

  private async dial(peerId: string): Promise<void> {
    const entry = this.ensurePeer(peerId, true);
    const dc = entry.pc.createDataChannel('ops', { ordered: true });
    this.attachDataChannel(peerId, entry, dc);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    this.events.sendSignal(peerId, entry.pc.localDescription);
  }

  private attachDataChannel(
    peerId: string,
    entry: PeerEntry,
    dc: RTCDataChannel,
  ): void {
    entry.dc = dc;
    dc.onopen = () => {
      entry.open = true;
      // Flush any queued messages.
      for (const msg of entry.queue) {
        try { dc.send(msg); } catch { /* channel closed race */ }
      }
      entry.queue.length = 0;
      this.events.onConnectivityChange(this.openPeerIds().length, this.openPeerIds());
    };
    dc.onclose = () => {
      entry.open = false;
      this.events.onConnectivityChange(this.openPeerIds().length, this.openPeerIds());
    };
    dc.onmessage = (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'op' && msg.op) {
        this.events.onPeerOp(msg.op, peerId);
      } else if (msg.type === 'presence' && msg.state && this.events.onPeerPresence) {
        this.events.onPeerPresence(msg.state, peerId);
      }
    };
  }

  private sendToAll(msg: unknown): number {
    const text = JSON.stringify(msg);
    let n = 0;
    for (const entry of this.peers.values()) {
      if (entry.open && entry.dc) {
        try {
          entry.dc.send(text);
          n++;
        } catch {
          // Channel closed between check and send — ignore; server fallback covers it.
        }
      } else {
        // Queue until open; caps at a reasonable size to avoid unbounded growth.
        if (entry.queue.length < 256) entry.queue.push(text);
      }
    }
    return n;
  }

  private disconnect(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    try { entry.dc?.close(); } catch { /* noop */ }
    try { entry.pc.close(); } catch { /* noop */ }
    if (entry.open) {
      this.events.onConnectivityChange(this.openPeerIds().length, this.openPeerIds());
    }
  }
}
