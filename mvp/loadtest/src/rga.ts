/**
 * Copy of the client RGA, stripped to just what the load test needs.
 *
 * Kept standalone so the loadtest has no build-time dep on the Vite client
 * tree. If the canonical RGA evolves, this file needs a corresponding update
 * — there's a convergence test here that will fail loudly if they drift.
 */

export type OpId = { c: string; l: number };

export type InsertOp = {
  type: 'insert';
  id: OpId;
  parent: OpId | null;
  ch: string;
};

export type DeleteOp = {
  type: 'delete';
  id: OpId;
};

export type Op = InsertOp | DeleteOp;

type Node = {
  id: OpId;
  ch: string;
  deleted: boolean;
  children: Node[];
};

function idKey(id: OpId): string {
  return `${id.c}:${id.l}`;
}

function rgaCompare(a: OpId, b: OpId): number {
  if (a.l !== b.l) return b.l - a.l;
  return a.c < b.c ? 1 : a.c > b.c ? -1 : 0;
}

export class RGA {
  readonly clientId: string;
  private lamport = 0;
  private root: Node = {
    id: { c: '__root__', l: 0 },
    ch: '',
    deleted: true,
    children: [],
  };
  private nodes = new Map<string, Node>();
  private flat: Node[] = [];

  constructor(clientId: string) {
    this.clientId = clientId;
    this.nodes.set(idKey(this.root.id), this.root);
    this.rebuildFlat();
  }

  toString(): string {
    let out = '';
    for (const n of this.flat) if (!n.deleted) out += n.ch;
    return out;
  }

  visibleLength(): number {
    let n = 0;
    for (const x of this.flat) if (!x.deleted) n++;
    return n;
  }

  localInsert(index: number, text: string): Op[] {
    const ops: Op[] = [];
    let parentId: OpId | null = this.visibleIdBefore(index);
    for (const ch of text) {
      this.lamport++;
      const op: InsertOp = {
        type: 'insert',
        id: { c: this.clientId, l: this.lamport },
        parent: parentId,
        ch,
      };
      this.applyInsert(op);
      ops.push(op);
      parentId = op.id;
    }
    this.rebuildFlat();
    return ops;
  }

  localDelete(index: number, count: number): Op[] {
    const ops: Op[] = [];
    const targets: Node[] = [];
    let seen = 0;
    for (const n of this.flat) {
      if (n.deleted) continue;
      if (seen >= index && targets.length < count) targets.push(n);
      seen++;
      if (targets.length >= count) break;
    }
    for (const n of targets) {
      if (n.deleted) continue;
      n.deleted = true;
      ops.push({ type: 'delete', id: n.id });
      this.lamport++;
    }
    this.rebuildFlat();
    return ops;
  }

  applyRemote(op: Op): boolean {
    if ('id' in op) this.lamport = Math.max(this.lamport, op.id.l);
    if (op.type === 'insert') {
      if (this.nodes.has(idKey(op.id))) return false;
      this.applyInsert(op);
      this.rebuildFlat();
      return true;
    } else {
      const n = this.nodes.get(idKey(op.id));
      if (!n || n.deleted) return false;
      n.deleted = true;
      this.rebuildFlat();
      return true;
    }
  }

  private applyInsert(op: InsertOp): void {
    const parentKey = op.parent ? idKey(op.parent) : idKey(this.root.id);
    const parent = this.nodes.get(parentKey) ?? this.root;
    const node: Node = { id: op.id, ch: op.ch, deleted: false, children: [] };
    const arr = parent.children;
    let i = 0;
    while (i < arr.length && rgaCompare(arr[i].id, op.id) < 0) i++;
    arr.splice(i, 0, node);
    this.nodes.set(idKey(op.id), node);
  }

  private rebuildFlat(): void {
    const out: Node[] = [];
    const walk = (n: Node) => {
      for (const child of n.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this.root);
    this.flat = out;
  }

  private visibleIdBefore(index: number): OpId | null {
    if (index <= 0) return null;
    let seen = 0;
    for (const n of this.flat) {
      if (n.deleted) continue;
      seen++;
      if (seen === index) return n.id;
    }
    for (let i = this.flat.length - 1; i >= 0; i--) {
      if (!this.flat[i].deleted) return this.flat[i].id;
    }
    return null;
  }
}
