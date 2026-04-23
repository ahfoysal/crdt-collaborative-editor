/**
 * Replicated Growable Array (RGA) CRDT for plaintext.
 *
 * Each character is a node with a unique globally-ordered ID
 *   id = { client: string, lamport: number }
 *
 * Insertions point to the ID of the node they come *after* (`parent`). The
 * document is a doubly-linked list of nodes, kept in insertion-tree order.
 * When two nodes have the same parent (concurrent inserts at the same spot),
 * we tie-break with RGA's standard rule: higher lamport first, then higher
 * clientId. This gives a total order that every replica computes identically,
 * so replicas converge without coordination.
 *
 * Deletions are tombstones (node.deleted = true) so that later insertions
 * whose parent was deleted still have a stable anchor.
 *
 * This is the minimum viable RGA — no run-length encoding, no GC, no cursor
 * transforms. Good enough for a 2-tab demo.
 */

export type OpId = { c: string; l: number };

export type InsertOp = {
  type: 'insert';
  id: OpId;
  parent: OpId | null; // null = beginning of document
  ch: string;
};

export type DeleteOp = {
  type: 'delete';
  id: OpId; // id of the node being deleted
};

export type Op = InsertOp | DeleteOp;

type Node = {
  id: OpId;
  ch: string;
  deleted: boolean;
  // Children in RGA order (newest/highest-priority first).
  children: Node[];
};

function idKey(id: OpId): string {
  return `${id.c}:${id.l}`;
}

/** Sort comparator: higher lamport wins; ties broken by higher clientId. */
function rgaCompare(a: OpId, b: OpId): number {
  if (a.l !== b.l) return b.l - a.l;
  return a.c < b.c ? 1 : a.c > b.c ? -1 : 0;
}

export class RGA {
  readonly clientId: string;
  private lamport = 0;

  // Synthetic root node. parent=null inserts attach as its children.
  private root: Node = {
    id: { c: '__root__', l: 0 },
    ch: '',
    deleted: true,
    children: [],
  };
  private nodes = new Map<string, Node>();

  // Flat visible order cache, rebuilt from the tree on each change.
  // For an MVP this is fine; larger docs would want an incremental structure.
  private flat: Node[] = [];

  constructor(clientId: string) {
    this.clientId = clientId;
    this.nodes.set(idKey(this.root.id), this.root);
    this.rebuildFlat();
  }

  /** Current visible text. */
  toString(): string {
    let out = '';
    for (const n of this.flat) if (!n.deleted) out += n.ch;
    return out;
  }

  /** Local insert at visible index `index` of string `text`. Returns ops. */
  localInsert(index: number, text: string): Op[] {
    const ops: Op[] = [];
    // Anchor is the visible node immediately before `index`, or null if index=0.
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
      parentId = op.id; // next char chains off the one we just inserted
    }
    this.rebuildFlat();
    return ops;
  }

  /** Local delete of `count` visible chars starting at visible `index`. */
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

  /** Apply a remote op. Returns true if it changed visible text. */
  applyRemote(op: Op): boolean {
    // Keep our lamport ahead of anything we've seen.
    if ('id' in op) this.lamport = Math.max(this.lamport, op.id.l);
    if (op.type === 'insert') {
      if (this.nodes.has(idKey(op.id))) return false; // duplicate
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

  // ---- internals ------------------------------------------------------

  private applyInsert(op: InsertOp): void {
    const parentKey = op.parent ? idKey(op.parent) : idKey(this.root.id);
    const parent = this.nodes.get(parentKey) ?? this.root;
    const node: Node = { id: op.id, ch: op.ch, deleted: false, children: [] };
    // Insert into parent.children sorted so children[0] is highest priority.
    const arr = parent.children;
    let i = 0;
    while (i < arr.length && rgaCompare(arr[i].id, op.id) < 0) i++;
    arr.splice(i, 0, node);
    this.nodes.set(idKey(op.id), node);
  }

  /** DFS through the tree in RGA order, producing a flat sequence of nodes. */
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
    // index past end → anchor to last visible (or null if empty)
    for (let i = this.flat.length - 1; i >= 0; i--) {
      if (!this.flat[i].deleted) return this.flat[i].id;
    }
    return null;
  }
}
