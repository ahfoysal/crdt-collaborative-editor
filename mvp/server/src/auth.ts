/**
 * JWT auth + per-document permissions (M5).
 *
 * We don't want a real user system in the MVP — a shared secret + self-signed
 * HS256 JWTs are enough to gate ops. Each token carries a `sub` (userId) and
 * optional `name`. Permissions live in a JSON file on disk keyed by docId
 * (this MVP is a single doc, so docId defaults to `"default"`):
 *
 *   { [docId]: { owner: userId, roles: { [userId]: 'owner'|'editor'|'viewer' } } }
 *
 * Role semantics:
 *   - owner  : full control; can change permissions
 *   - editor : can send ops, presence, signaling
 *   - viewer : can read (gets `sync`, presence), ops are rejected
 *
 * For the load test / local dev there is an `AUTH_DISABLED` env flag: when set,
 * every socket is treated as an editor (`sub` = clientId), so the unchanged
 * MVP demo keeps working without tokens.
 *
 * HS256 is implemented inline — node's `crypto` is enough and pulling in a JWT
 * lib for a single algorithm is overkill here.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';

export type Role = 'owner' | 'editor' | 'viewer';

export type DocPerms = {
  owner: string;
  roles: Record<string, Role>;
};

export type PermsFile = Record<string, DocPerms>;

export type AuthPayload = {
  sub: string;           // userId
  name?: string;
  iat?: number;
  exp?: number;
};

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-shared-secret-change-me';
export const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
const PERMS_PATH = process.env.PERMS_PATH ?? './perms.json';

// -- base64url helpers ------------------------------------------------------

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

// -- sign / verify ----------------------------------------------------------

export function signToken(payload: AuthPayload, secret: string = JWT_SECRET): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body: AuthPayload = { iat: now, ...payload };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(body));
  const sig = b64urlEncode(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

export function verifyToken(
  token: string,
  secret: string = JWT_SECRET,
): AuthPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = b64urlDecode(sig);
  if (expected.length !== got.length) return null;
  if (!timingSafeEqual(expected, got)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(p).toString('utf8')) as AuthPayload;
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

// -- permissions store ------------------------------------------------------

export class PermsStore {
  private data: PermsFile = {};
  private path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string = PERMS_PATH) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as PermsFile;
      if (parsed && typeof parsed === 'object') this.data = parsed;
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  }

  /** Get perms for a doc, creating a default entry (with `ownerId` as owner). */
  ensureDoc(docId: string, ownerId: string): DocPerms {
    let doc = this.data[docId];
    if (!doc) {
      doc = { owner: ownerId, roles: { [ownerId]: 'owner' } };
      this.data[docId] = doc;
      this.schedulePersist();
    }
    return doc;
  }

  get(docId: string): DocPerms | undefined {
    return this.data[docId];
  }

  roleOf(docId: string, userId: string): Role | null {
    const doc = this.data[docId];
    if (!doc) return null;
    return doc.roles[userId] ?? null;
  }

  /** Only owners can set roles. Returns true if the change was applied. */
  setRole(docId: string, actor: string, target: string, role: Role): boolean {
    const doc = this.data[docId];
    if (!doc) return false;
    if (doc.roles[actor] !== 'owner') return false;
    doc.roles[target] = role;
    if (role === 'owner') doc.owner = target;
    this.schedulePersist();
    return true;
  }

  canWrite(docId: string, userId: string): boolean {
    if (AUTH_DISABLED) return true;
    const role = this.roleOf(docId, userId);
    return role === 'owner' || role === 'editor';
  }

  canRead(docId: string, userId: string): boolean {
    if (AUTH_DISABLED) return true;
    const role = this.roleOf(docId, userId);
    return role === 'owner' || role === 'editor' || role === 'viewer';
  }

  private schedulePersist(): void {
    this.writeQueue = this.writeQueue.then(() => this.writeFile());
    this.writeQueue.catch((err) => console.error('[perms] persist failed', err));
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async writeFile(): Promise<void> {
    const tmp = this.path + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, this.path);
  }
}

/**
 * Authenticate a `hello` message. Returns the decoded payload if the token is
 * valid, a pseudo-payload if auth is disabled, or null if the token is bad.
 */
export function authenticateHello(
  helloMsg: { token?: unknown; clientId?: unknown },
): AuthPayload | null {
  if (AUTH_DISABLED) {
    const cid = typeof helloMsg.clientId === 'string' ? helloMsg.clientId : 'anon';
    return { sub: cid, name: cid };
  }
  if (typeof helloMsg.token !== 'string') return null;
  return verifyToken(helloMsg.token);
}
