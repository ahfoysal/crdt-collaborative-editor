/**
 * WebRTC mesh tests — uses a fake RTCPeerConnection that short-circuits the
 * SDP/ICE handshake through a shared in-process "fabric". Real browsers do
 * the same dance but with real SDP; for unit tests we just need the control
 * flow (offer -> answer -> data channel open -> message round trip) to be
 * reproducible and deterministic.
 */
import { describe, it, expect, vi } from 'vitest';
import { WebRtcMesh } from './webrtc';

// -- Fake RTC ---------------------------------------------------------------

class FakeDC {
  readyState = 'connecting';
  label: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  peer: FakeDC | null = null;
  constructor(label: string) { this.label = label; }
  send(data: string) {
    if (this.readyState !== 'open') throw new Error('not open');
    const peer = this.peer;
    if (peer?.onmessage) setTimeout(() => peer.onmessage?.({ data }), 0);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    if (this.peer && this.peer.readyState !== 'closed') this.peer.close();
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
}

/**
 * The fabric pairs FakePCs by (localId, remoteId). When both sides have
 * registered and SDP has been exchanged, we link their data channels.
 */
class Fabric {
  // Map each PC instance to an id label assigned at creation.
  pcs = new Map<FakePC, { localId: string }>();
  // Pending channels waiting for a peer: key = initiator label
  channels = new Map<string, FakeDC>();

  register(pc: FakePC, localId: string) {
    this.pcs.set(pc, { localId });
  }

  pairChannel(initiatorPc: FakePC, dc: FakeDC) {
    // Find the responder for this pair.
    const entry = this.pcs.get(initiatorPc);
    if (!entry) return;
    const responder = [...this.pcs.entries()].find(
      ([other]) => other !== initiatorPc && other._peerLabel === entry.localId,
    );
    if (!responder) {
      // Responder not yet set up; queue.
      this.channels.set(entry.localId + '->' + initiatorPc._peerLabel, dc);
      return;
    }
    const [respPc] = responder;
    const incoming = new FakeDC('ops');
    dc.peer = incoming;
    incoming.peer = dc;
    // Deliver to responder via ondatachannel.
    setTimeout(() => {
      respPc.ondatachannel?.({ channel: incoming } as unknown as RTCDataChannelEvent);
      dc.open();
      incoming.open();
    }, 0);
  }
}

class FakePC {
  static fabric = new Fabric();
  _label = '';
  _peerLabel = '';
  localDescription: any = null;
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: RTCDataChannelEvent) => void) | null = null;
  _createdDC: FakeDC | null = null;

  createDataChannel(label: string): FakeDC {
    const dc = new FakeDC(label);
    this._createdDC = dc;
    return dc;
  }
  async createOffer() {
    return { type: 'offer', sdp: `offer-from-${this._label}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `answer-from-${this._label}` };
  }
  async setLocalDescription(d: any) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: any) {
    if (d.type === 'offer') {
      // Remote offered — record who the offerer is.
      const m = /(offer|answer)-from-(.+)/.exec(d.sdp);
      if (m) this._peerLabel = m[2];
    } else if (d.type === 'answer') {
      // Answer received — link DC to the responder's channel.
      const m = /(offer|answer)-from-(.+)/.exec(d.sdp);
      if (m) this._peerLabel = m[2];
      if (this._createdDC) FakePC.fabric.pairChannel(this, this._createdDC);
    }
  }
  async addIceCandidate() { /* noop — no real ICE */ }
  close() {
    this.connectionState = 'closed';
    this.onconnectionstatechange?.();
  }
}

function makeMesh(clientId: string) {
  const pc = new FakePC();
  pc._label = clientId;
  const received: Array<{ op: unknown; from: string }> = [];
  let openPeers = 0;
  const signals: Array<{ to: string; data: unknown }> = [];
  const mesh = new WebRtcMesh(clientId, {
    onPeerOp: (op, from) => received.push({ op, from }),
    onConnectivityChange: (n) => { openPeers = n; },
    sendSignal: (to, data) => signals.push({ to, data }),
  }, {
    rtcFactory: () => {
      const newPc = new FakePC();
      newPc._label = clientId;
      FakePC.fabric.register(newPc, clientId);
      return newPc as unknown as RTCPeerConnection;
    },
  });
  return {
    mesh,
    received,
    signals,
    get openPeers() { return openPeers; },
  };
}

describe('WebRtcMesh', () => {
  it('initiator is the lexicographically smaller clientId', async () => {
    const a = makeMesh('alice');
    const b = makeMesh('bob');
    expect((a.mesh as any).amInitiator('bob')).toBe(true);
    expect((b.mesh as any).amInitiator('alice')).toBe(false);
  });

  it('establishes a channel and round-trips an op between two clients', async () => {
    // Fresh fabric for this test.
    FakePC.fabric = new (FakePC.fabric.constructor as any)();
    const a = makeMesh('alice');
    const b = makeMesh('bob');

    // Wire signaling relay: a<->b. sendSignal(to, data) -> peer.onSignal.
    const relay = async (src: ReturnType<typeof makeMesh>, dst: ReturnType<typeof makeMesh>, srcId: string, dstId: string) => {
      while (src.signals.length > 0) {
        const sig = src.signals.shift()!;
        if (sig.to !== dstId) continue;
        await dst.mesh.onSignal({ from: srcId, to: dstId, data: sig.data });
      }
    };

    // Both peers learn about each other.
    await a.mesh.setPeerList(['bob']);
    await b.mesh.setPeerList(['alice']);

    // Drive signals to completion.
    for (let i = 0; i < 10; i++) {
      await relay(a, b, 'alice', 'bob');
      await relay(b, a, 'bob', 'alice');
      // Let microtasks + setTimeout(0)s flush.
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(a.openPeers).toBe(1);
    expect(b.openPeers).toBe(1);

    // Send an op from alice -> bob.
    const sent = a.mesh.broadcastOp({ type: 'insert', id: { c: 'alice', l: 1 }, ch: 'x' });
    expect(sent).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(b.received).toHaveLength(1);
    expect(b.received[0].from).toBe('alice');
    expect((b.received[0].op as any).ch).toBe('x');

    // And bob -> alice.
    b.mesh.broadcastOp({ type: 'insert', id: { c: 'bob', l: 1 }, ch: 'y' });
    await new Promise((r) => setTimeout(r, 5));
    expect(a.received).toHaveLength(1);
    expect((a.received[0].op as any).ch).toBe('y');
  });

  it('queues pre-open messages and flushes on open', async () => {
    FakePC.fabric = new (FakePC.fabric.constructor as any)();
    const a = makeMesh('alice');
    const b = makeMesh('bob');

    await a.mesh.setPeerList(['bob']);
    await b.mesh.setPeerList(['alice']);

    // Alice queues an op before the channel has opened.
    const reach = a.mesh.broadcastOp({ type: 'insert', id: { c: 'alice', l: 2 }, ch: 'q' });
    expect(reach).toBe(0); // no open peers yet

    // Now drive signaling to completion.
    for (let i = 0; i < 10; i++) {
      while (a.signals.length) {
        const s = a.signals.shift()!;
        await b.mesh.onSignal({ from: 'alice', to: 'bob', data: s.data });
      }
      while (b.signals.length) {
        const s = b.signals.shift()!;
        await a.mesh.onSignal({ from: 'bob', to: 'alice', data: s.data });
      }
      await new Promise((r) => setTimeout(r, 1));
    }

    // Queued op flushes automatically on open.
    await new Promise((r) => setTimeout(r, 5));
    expect(b.received).toHaveLength(1);
    expect((b.received[0].op as any).ch).toBe('q');
  });

  it('close tears down peers and drops connectivity', async () => {
    FakePC.fabric = new (FakePC.fabric.constructor as any)();
    const a = makeMesh('alice');
    const b = makeMesh('bob');
    await a.mesh.setPeerList(['bob']);
    await b.mesh.setPeerList(['alice']);
    for (let i = 0; i < 10; i++) {
      while (a.signals.length) {
        const s = a.signals.shift()!;
        await b.mesh.onSignal({ from: 'alice', to: 'bob', data: s.data });
      }
      while (b.signals.length) {
        const s = b.signals.shift()!;
        await a.mesh.onSignal({ from: 'bob', to: 'alice', data: s.data });
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(a.openPeers).toBe(1);
    a.mesh.close();
    expect(a.mesh.openPeerIds()).toEqual([]);
  });
});
