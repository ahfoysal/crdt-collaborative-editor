import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, PermsStore } from './auth.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('JWT HS256', () => {
  it('round-trips a payload with the shared secret', () => {
    const tok = signToken({ sub: 'alice' }, 'secret123');
    const payload = verifyToken(tok, 'secret123');
    expect(payload?.sub).toBe('alice');
  });
  it('rejects tampered tokens', () => {
    const tok = signToken({ sub: 'alice' }, 'secret123');
    const parts = tok.split('.');
    const bad = `${parts[0]}.${parts[1]}.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`;
    expect(verifyToken(bad, 'secret123')).toBeNull();
  });
  it('rejects wrong secret', () => {
    const tok = signToken({ sub: 'alice' }, 'secret123');
    expect(verifyToken(tok, 'other')).toBeNull();
  });
  it('rejects expired tokens', () => {
    const tok = signToken({ sub: 'alice', exp: Math.floor(Date.now() / 1000) - 10 }, 'secret123');
    expect(verifyToken(tok, 'secret123')).toBeNull();
  });
});

describe('PermsStore', () => {
  it('first user of a doc becomes owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perms-'));
    const store = new PermsStore(join(dir, 'perms.json'));
    await store.load();
    store.ensureDoc('doc1', 'alice');
    expect(store.roleOf('doc1', 'alice')).toBe('owner');
    expect(store.canWrite('doc1', 'alice')).toBe(true);
    expect(store.canWrite('doc1', 'bob')).toBe(false);
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  });
  it('owner can add editors and viewers; viewer cannot write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perms-'));
    const store = new PermsStore(join(dir, 'perms.json'));
    await store.load();
    store.ensureDoc('doc1', 'alice');
    expect(store.setRole('doc1', 'alice', 'bob', 'editor')).toBe(true);
    expect(store.setRole('doc1', 'alice', 'carol', 'viewer')).toBe(true);
    expect(store.canWrite('doc1', 'bob')).toBe(true);
    expect(store.canRead('doc1', 'carol')).toBe(true);
    expect(store.canWrite('doc1', 'carol')).toBe(false);
    // Non-owner cannot promote.
    expect(store.setRole('doc1', 'bob', 'carol', 'editor')).toBe(false);
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  });
});
