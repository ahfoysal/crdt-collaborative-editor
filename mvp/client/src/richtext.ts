/**
 * Rich-text CRDT — a Y.Text-style extension of our M1 RGA.
 *
 * Each character node carries an `attributes` map (bold / italic / underline,
 * etc.). Attributes are applied as a separate op type (`format`) that names
 * the target node IDs, the attribute key, the new boolean value, and a
 * lamport timestamp. Per-attribute conflicts are resolved by last-writer-wins:
 *   highest lamport wins, tie-break by higher clientId.
 *
 * Ordering of character nodes is identical to the plaintext RGA:
 *   - concurrent inserts at the same anchor are sorted by (lamport desc,
 *     clientId desc)
 *   - deletions are tombstones so future inserts keep a stable anchor
 *
 * Format ops are idempotent and commutative because each attribute key on
 * each node has an independent LWW register. Inserts carry an optional
 * `attributes` snapshot so a new character typed mid-selection is born with
 * the surrounding formatting without needing a follow-up format op.
 *
 * Public API:
 *   - localInsert(index, text, attrs?) -> Op[]
 *   - localDelete(index, count)        -> Op[]
 *   - format(start, end, attrs)        -> Op[]    (apply attrs to [start,end))
 *   - applyRemote(op)                  -> boolean (true if visible state changed)
 *   - toString()                       -> plain text
 *   - toRuns()                         -> { text, attrs }[]  (for rendering)
 *   - attrsAt(index)                   -> Record<string, boolean>
 */

export type OpId = { c: string; l: number };
export type Attrs = Record<string, boolean>;

export type InsertOp = {
  type: 'insert';
  id: OpId;
  parent: OpId | null;
  ch: string;
  attributes?: Attrs;
};

export type DeleteOp = {
  type: 'delete';
  id: OpId;
};

/**
 * A format op stamps a single attribute key/value across a set of character
 * IDs. We emit one format op per attribute key rather than bundling, which
 * keeps LWW resolution trivial (one register per (nodeId, key)).
 */
export type FormatOp = {
  type: 'format';
  id: OpId;           // lamport stamp of this format, used for LWW
  targets: OpId[];    // character nodes to mark
  key: string;        // attribute key (e.g. 'bold')
  value: boolean;     // on/off
};

export type Op = InsertOp | DeleteOp | FormatOp;

type AttrCell = {
  value: boolean;
  // Stamp that set this cell — used for LWW when a concurrent format arrives.
  lamport: number;
  clientId: string;
};

type Node = {
  id: OpId;
  ch: string;
  deleted: boolean;
  // Per-attribute LWW registers.
  attrs: Map<string, AttrCell>;
  children: Node[];
};

function idKey(id: OpId): string {
  return `${id.c}:${id.l}`;
}

/** RGA tie-break: higher lamport wins, then higher clientId. */
function rgaCompare(a: OpId, b: OpId): number {
  if (a.l !== b.l) return b.l - a.l;
  return a.c < b.c ? 1 : a.c > b.c ? -1 : 0;
}

/** LWW compare: returns true if `incoming` should overwrite `existing`. */
function lwwWins(incoming: { lamport: number; clientId: string }, existing: AttrCell): boolean {
  if (incoming.lamport !== existing.lamport) return incoming.lamport > existing.lamport;
  return incoming.clientId > existing.clientId;
}

function cellToAttrs(node: Node): Attrs {
  const out: Attrs = {};
  for (const [k, v] of node.attrs) if (v.value) out[k] = true;
  return out;
}

function attrsEqual(a: Attrs, b: Attrs): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export class RichText {
  readonly clientId: string;
  private lamport = 0;

  private root: Node = {
    id: { c: '__root__', l: 0 },
    ch: '',
    deleted: true,
    attrs: new Map(),
    children: [],
  };
  private nodes = new Map<string, Node>();
  private flat: Node[] = [];

  constructor(clientId: string) {
    this.clientId = clientId;
    this.nodes.set(idKey(this.root.id), this.root);
    this.rebuildFlat();
  }

  /** Current visible plain text. */
  toString(): string {
    let out = '';
    for (const n of this.flat) if (!n.deleted) out += n.ch;
    return out;
  }

  /** Ordered list of visible (text, attrs) runs for rendering. */
  toRuns(): { text: string; attrs: Attrs }[] {
    const runs: { text: string; attrs: Attrs }[] = [];
    let current: { text: string; attrs: Attrs } | null = null;
    for (const n of this.flat) {
      if (n.deleted) continue;
      const a = cellToAttrs(n);
      if (current && attrsEqual(current.attrs, a)) {
        current.text += n.ch;
      } else {
        current = { text: n.ch, attrs: a };
        runs.push(current);
      }
    }
    return runs;
  }

  /** Attribute snapshot of the visible char at `index` (0-based). */
  attrsAt(index: number): Attrs {
    let seen = 0;
    for (const n of this.flat) {
      if (n.deleted) continue;
      if (seen === index) return cellToAttrs(n);
      seen++;
    }
    return {};
  }

  /** Iterate visible nodes (for selection -> ID mapping in the UI). */
  visibleNodes(): Node[] {
    return this.flat.filter((n) => !n.deleted);
  }

  /** Local insert at visible index. `attrs` are carried on the new chars. */
  localInsert(index: number, text: string, attrs?: Attrs): Op[] {
    const ops: Op[] = [];
    let parentId: OpId | null = this.visibleIdBefore(index);
    for (const ch of text) {
      this.lamport++;
      const op: InsertOp = {
        type: 'insert',
        id: { c: this.clientId, l: this.lamport },
        parent: parentId,
        ch,
        attributes: attrs && Object.keys(attrs).length > 0 ? { ...attrs } : undefined,
      };
      this.applyInsert(op);
      ops.push(op);
      parentId = op.id;
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

  /**
   * Apply the (key,value) pairs in `attrs` to every visible char in
   * [start, end). Emits one FormatOp per attribute key.
   */
  format(start: number, end: number, attrs: Attrs): Op[] {
    if (end <= start) return [];
    const targets: OpId[] = [];
    let seen = 0;
    for (const n of this.flat) {
      if (n.deleted) continue;
      if (seen >= start && seen < end) targets.push(n.id);
      seen++;
      if (seen >= end) break;
    }
    if (targets.length === 0) return [];

    const ops: Op[] = [];
    for (const [key, value] of Object.entries(attrs)) {
      this.lamport++;
      const op: FormatOp = {
        type: 'format',
        id: { c: this.clientId, l: this.lamport },
        targets,
        key,
        value,
      };
      this.applyFormat(op);
      ops.push(op);
    }
    this.rebuildFlat();
    return ops;
  }

  /** Apply a remote op. Returns true if visible text/attrs changed. */
  applyRemote(op: Op): boolean {
    if ('id' in op) this.lamport = Math.max(this.lamport, op.id.l);

    if (op.type === 'insert') {
      if (this.nodes.has(idKey(op.id))) return false;
      this.applyInsert(op);
      this.rebuildFlat();
      return true;
    }
    if (op.type === 'delete') {
      const n = this.nodes.get(idKey(op.id));
      if (!n || n.deleted) return false;
      n.deleted = true;
      this.rebuildFlat();
      return true;
    }
    // format
    const changed = this.applyFormat(op);
    if (changed) this.rebuildFlat();
    return changed;
  }

  // ---- internals ------------------------------------------------------

  private applyInsert(op: InsertOp): void {
    const parentKey = op.parent ? idKey(op.parent) : idKey(this.root.id);
    const parent = this.nodes.get(parentKey) ?? this.root;
    const node: Node = {
      id: op.id,
      ch: op.ch,
      deleted: false,
      attrs: new Map(),
      children: [],
    };
    if (op.attributes) {
      for (const [k, v] of Object.entries(op.attributes)) {
        node.attrs.set(k, { value: v, lamport: op.id.l, clientId: op.id.c });
      }
    }
    const arr = parent.children;
    let i = 0;
    while (i < arr.length && rgaCompare(arr[i].id, op.id) < 0) i++;
    arr.splice(i, 0, node);
    this.nodes.set(idKey(op.id), node);
  }

  private applyFormat(op: FormatOp): boolean {
    let changed = false;
    for (const t of op.targets) {
      const n = this.nodes.get(idKey(t));
      if (!n) continue;
      const existing = n.attrs.get(op.key);
      const incoming = { lamport: op.id.l, clientId: op.id.c };
      if (!existing || lwwWins(incoming, existing)) {
        const prevVisible = existing?.value ?? false;
        n.attrs.set(op.key, { value: op.value, lamport: op.id.l, clientId: op.id.c });
        if (!n.deleted && prevVisible !== op.value) changed = true;
      }
    }
    return changed;
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
