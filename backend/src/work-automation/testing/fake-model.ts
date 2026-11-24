// A tiny in-memory stand-in for a Mongoose model, for unit tests of the
// work-automation services. Supports the subset of Mongo they use: equality,
// $in/$nin/$ne/$gt/$gte/$lt/$lte/$exists/$or/$and, and update operators
// $set/$setOnInsert/$unset/$inc/$push/$addToSet, upserts and a unique-key
// guard (throws code 11000 like Mongo). Not for production use.

type Doc = Record<string, unknown> & { _id: string };

let counter = 0;
const newId = () => (++counter).toString(16).padStart(24, '0');

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), obj);
}

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number);
  const bv = b instanceof Date ? b.getTime() : (b as number);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    const ops = cond as Record<string, unknown>;
    if (Object.keys(ops).some((k) => k.startsWith('$'))) {
      return Object.entries(ops).every(([op, v]) => {
        switch (op) {
          case '$in':
            return (v as unknown[]).some((x) => (Array.isArray(actual) ? actual.includes(x) : x === actual || (x == null && actual == null)));
          case '$nin':
            return !(v as unknown[]).some((x) => x === actual || (x == null && actual == null));
          case '$ne':
            return actual !== v && !(v == null && actual == null);
          case '$gt':
            return actual != null && cmp(actual, v) > 0;
          case '$gte':
            return actual != null && cmp(actual, v) >= 0;
          case '$lt':
            return actual != null && cmp(actual, v) < 0;
          case '$lte':
            return actual != null && cmp(actual, v) <= 0;
          case '$exists':
            return (actual !== undefined) === Boolean(v);
          default:
            throw new Error(`fake-model: unsupported operator ${op}`);
        }
      });
    }
  }
  if (cond == null) return actual == null;
  if (Array.isArray(actual) && !Array.isArray(cond)) return actual.includes(cond);
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  return actual === cond;
}

export function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return (v as Record<string, unknown>[]).some((f) => matches(doc, f));
    if (k === '$and') return (v as Record<string, unknown>[]).every((f) => matches(doc, f));
    return matchValue(getPath(doc, k), v);
  });
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] == null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj: Record<string, unknown>, path: string) {
  const parts = path.split('.');
  let cur: Record<string, unknown> | undefined = obj;
  for (const p of parts.slice(0, -1)) cur = cur?.[p] as Record<string, unknown> | undefined;
  if (cur) delete cur[parts[parts.length - 1]];
}

export function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>, inserting: boolean) {
  const hasOps = Object.keys(update).some((k) => k.startsWith('$'));
  if (!hasOps) {
    Object.assign(doc, update);
    return;
  }
  for (const [op, body] of Object.entries(update)) {
    const entries = Object.entries(body as Record<string, unknown>);
    if (op === '$set') entries.forEach(([k, v]) => setPath(doc, k, v));
    else if (op === '$setOnInsert') {
      if (inserting) entries.forEach(([k, v]) => setPath(doc, k, v));
    } else if (op === '$unset') entries.forEach(([k]) => unsetPath(doc, k));
    else if (op === '$inc') entries.forEach(([k, v]) => setPath(doc, k, ((getPath(doc, k) as number) ?? 0) + (v as number)));
    else if (op === '$push')
      entries.forEach(([k, v]) => {
        const arr = (getPath(doc, k) as unknown[]) ?? [];
        setPath(doc, k, [...arr, v]);
      });
    else if (op === '$addToSet')
      entries.forEach(([k, v]) => {
        const arr = (getPath(doc, k) as unknown[]) ?? [];
        setPath(doc, k, arr.includes(v) ? arr : [...arr, v]);
      });
    else throw new Error(`fake-model: unsupported update operator ${op}`);
  }
}

type Query<T> = PromiseLike<T> & {
  exec(): Promise<T>;
  select(f?: unknown): Query<T>;
  sort(s?: Record<string, 1 | -1>): Query<T>;
  limit(n: number): Query<T>;
  lean(): Query<T>;
};

function query<T>(run: (sort?: Record<string, 1 | -1>, limit?: number) => T): Query<T> {
  let sortBy: Record<string, 1 | -1> | undefined;
  let max: number | undefined;
  const q: Query<T> = {
    exec: async () => run(sortBy, max),
    select: () => q,
    sort: (s) => {
      sortBy = s;
      return q;
    },
    limit: (n) => {
      max = n;
      return q;
    },
    lean: () => q,
    then: (a, b) => q.exec().then(a, b),
  };
  return q;
}

export class FakeModel {
  docs: Doc[] = [];
  /** Field-sets that must stay unique, like Mongoose unique indexes. */
  constructor(
    private uniqueKeys: string[][] = [],
    /** Fields stamped with the creation time (Mongoose timestamps). */
    private stamps: string[] = [],
  ) {}

  private wrap(d: Doc | null) {
    if (!d) return null;
    const out = d as Doc & { id: string; toObject: () => Doc };
    out.id = d._id;
    return out;
  }
  private clone<T>(v: T): T {
    return v == null ? v : (structuredClone(v) as T);
  }
  private checkUnique(doc: Doc, ignoreId?: string) {
    for (const keys of this.uniqueKeys) {
      const dup = this.docs.find((o) => o._id !== ignoreId && o._id !== doc._id && keys.every((k) => getPath(o, k) === getPath(doc, k) && getPath(doc, k) !== undefined));
      if (dup) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
  }
  private sorted(rows: Doc[], sort?: Record<string, 1 | -1>) {
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      for (const [k, dir] of Object.entries(sort)) {
        const c = cmp(getPath(a, k), getPath(b, k));
        if (c) return c * dir;
      }
      return 0;
    });
  }

  async create(data: Record<string, unknown>) {
    const doc = { _id: newId(), ...this.clone(data) } as Doc;
    for (const f of this.stamps) if (doc[f] === undefined) doc[f] = new Date();
    this.checkUnique(doc);
    this.docs.push(doc);
    return this.wrap(doc);
  }
  findOne(filter: Record<string, unknown> = {}) {
    return query(() => this.wrap(this.docs.find((d) => matches(d, filter)) ?? null));
  }
  find(filter: Record<string, unknown> = {}) {
    return query((sort, limit) => {
      const rows = this.sorted(this.docs.filter((d) => matches(d, filter)), sort);
      return (limit ? rows.slice(0, limit) : rows).map((d) => this.wrap(d) as Doc);
    });
  }
  exists(filter: Record<string, unknown>) {
    return query(() => (this.docs.some((d) => matches(d, filter)) ? { _id: 'x' } : null));
  }
  countDocuments(filter: Record<string, unknown> = {}) {
    return query(() => this.docs.filter((d) => matches(d, filter)).length);
  }
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, opts: { upsert?: boolean; new?: boolean } = {}) {
    return query(() => {
      let doc = this.docs.find((d) => matches(d, filter));
      let inserting = false;
      if (!doc) {
        if (!opts.upsert) return null;
        inserting = true;
        doc = { _id: newId() } as Doc;
        for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && (v == null || typeof v !== 'object' || v instanceof Date)) setPath(doc, k, v);
      }
      const draft = this.clone(doc) as Doc;
      applyUpdate(draft, update, inserting);
      this.checkUnique(draft, doc._id);
      if (inserting) this.docs.push(draft);
      else this.docs[this.docs.indexOf(doc)] = draft;
      return this.wrap(draft);
    });
  }
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    return query(() => {
      const doc = this.docs.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update, false);
      return { matchedCount: 1, modifiedCount: 1 };
    });
  }
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    return query(() => {
      const hit = this.docs.filter((d) => matches(d, filter));
      hit.forEach((d) => applyUpdate(d, update, false));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    });
  }
  deleteMany(filter: Record<string, unknown>) {
    return query(() => {
      const before = this.docs.length;
      this.docs = this.docs.filter((d) => !matches(d, filter));
      return { deletedCount: before - this.docs.length };
    });
  }
}
