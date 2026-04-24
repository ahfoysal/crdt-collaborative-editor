/**
 * Presence tests — ephemeral awareness convergence across N clients.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Presence, colorFor, nameFor, type PresenceState } from './presence';

describe('Presence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns deterministic color + name from clientId', () => {
    expect(colorFor('alice')).toBe(colorFor('alice'));
    expect(nameFor('abcdef')).toBe('user-abcd');
  });

  it('setLocal broadcasts and caps burst via throttle', () => {
    const onBroadcast = vi.fn();
    const onChange = vi.fn();
    const p = new Presence('alice', { onBroadcast, onChange }, { throttleMs: 50 });

    p.setLocal({ anchor: 0, head: 0 });
    // First update broadcasts immediately.
    expect(onBroadcast).toHaveBeenCalledTimes(1);

    // Rapid updates within the throttle window coalesce into one later flush.
    vi.setSystemTime(new Date(1_700_000_000_010));
    p.setLocal({ anchor: 5, head: 5 });
    vi.setSystemTime(new Date(1_700_000_000_020));
    p.setLocal({ anchor: 10, head: 10 });
    expect(onBroadcast).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    // Match the wall-clock time advance so timer fires at the real threshold.
    vi.setSystemTime(new Date(1_700_000_000_050));
    expect(onBroadcast).toHaveBeenCalledTimes(2);
    const last = onBroadcast.mock.calls.at(-1)![0] as PresenceState;
    expect(last.anchor).toBe(10);
    expect(last.head).toBe(10);
  });

  it('multi-client states converge via LWW on ts', () => {
    // Three peers cross-broadcast their cursors; each applies the others'.
    const make = (id: string) => {
      const sent: PresenceState[] = [];
      const changes: PresenceState[][] = [];
      const p = new Presence(id, {
        onBroadcast: (s) => sent.push(s),
        onChange: (all) => changes.push(all),
      }, { throttleMs: 0 });
      return { p, sent, changes };
    };
    const a = make('alice');
    const b = make('bob');
    const c = make('carol');

    vi.setSystemTime(new Date(1_700_000_000_100));
    a.p.setLocal({ anchor: 1, head: 1 });
    vi.setSystemTime(new Date(1_700_000_000_200));
    b.p.setLocal({ anchor: 2, head: 2 });
    vi.setSystemTime(new Date(1_700_000_000_300));
    c.p.setLocal({ anchor: 3, head: 3 });

    // Cross-apply every peer's last broadcast.
    const last = (x: { sent: PresenceState[] }) => x.sent.at(-1)!;
    for (const [x, others] of [
      [a, [b, c]],
      [b, [a, c]],
      [c, [a, b]],
    ] as const) {
      for (const o of others) x.p.applyRemote(last(o));
    }

    // Each peer sees the other two with the expected heads.
    for (const [x, expected] of [
      [a, { bob: 2, carol: 3 }],
      [b, { alice: 1, carol: 3 }],
      [c, { alice: 1, bob: 2 }],
    ] as const) {
      const map = Object.fromEntries(x.p.getRemotes().map((s) => [s.clientId, s.head]));
      expect(map).toEqual(expected);
    }
  });

  it('applyRemote rejects older ts (LWW)', () => {
    const p = new Presence('me', { onBroadcast: vi.fn(), onChange: vi.fn() });
    const newer: PresenceState = {
      clientId: 'peer', name: 'peer', color: '#fff',
      anchor: 5, head: 5, ts: 100,
    };
    const older: PresenceState = { ...newer, head: 1, ts: 50 };
    expect(p.applyRemote(newer)).toBe(true);
    expect(p.applyRemote(older)).toBe(false);
    expect(p.getRemotes()[0].head).toBe(5);
  });

  it('applyRemote ignores self', () => {
    const onChange = vi.fn();
    const p = new Presence('me', { onBroadcast: vi.fn(), onChange });
    expect(p.applyRemote({
      clientId: 'me', name: 'me', color: '#fff',
      anchor: 0, head: 0, ts: 1,
    })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drop removes a peer and notifies', () => {
    const onChange = vi.fn();
    const p = new Presence('me', { onBroadcast: vi.fn(), onChange });
    p.applyRemote({
      clientId: 'peer', name: 'peer', color: '#fff',
      anchor: 0, head: 0, ts: 1,
    });
    expect(p.getRemotes()).toHaveLength(1);
    expect(p.drop('peer')).toBe(true);
    expect(p.getRemotes()).toHaveLength(0);
    expect(p.drop('peer')).toBe(false);
  });

  it('setLocal skips no-op updates', () => {
    const onBroadcast = vi.fn();
    const p = new Presence('me', { onBroadcast, onChange: vi.fn() }, { throttleMs: 0 });
    p.setLocal({ anchor: 1, head: 1 });
    const n = onBroadcast.mock.calls.length;
    p.setLocal({ anchor: 1, head: 1 });
    expect(onBroadcast.mock.calls.length).toBe(n);
  });
});
