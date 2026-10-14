// Which records belong to the same customer. The same person reaches HaiVE
// through several systems — an enquiry in one CRM, a quotation and an invoice
// in another — and none of them shares an id with the others. They are matched
// on what does identify a customer:
//
//   1. a link one record carries to another (an invoice to its quotation, a
//      quotation to its deal);
//   2. the same email address;
//   3. the same phone number;
//   4. for a record with neither email nor phone, the same company name — and
//      only when that name points at exactly one customer;
//   5. failing all of those, the same contact name among records that have
//      nothing else.
//
// A company name alone never merges two records that each have their own email
// or phone: two people at one company stay two contacts rather than being
// folded together on a guess.

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');

export interface MatchIdentity {
  name?: string;
  company?: string;
  email?: string;
  phone?: string;
}

export interface MatchRecord {
  identity: MatchIdentity;
  /** Other records (by index) this one is known to belong with. */
  links?: number[];
}

export const emailKey = (value: unknown): string => {
  const email = text(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
};

/** The last ten digits, so "+91 98400 12345" and "09840012345" are one number. Placeholders ("0000000000") are no number. */
export const phoneKey = (value: unknown): string => {
  const digits = text(value).replace(/\D/g, '');
  if (digits.length < 8) return '';
  const tail = digits.length >= 10 ? digits.slice(-10) : digits;
  return /^(\d)\1+$/.test(tail) ? '' : tail;
};

// What a form holds when the customer has no company to name.
const NO_COMPANY = new Set(['individual', 'personal', 'self', 'none', 'test', 'home', 'nill', 'notapplicable']);

/** A company name reduced to what identifies it ("Sundar Textiles Pvt. Ltd." → "sundartextiles"). */
export const companyKey = (value: unknown): string => {
  const key = text(value)
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|corp|corporation)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
  return key.length >= 4 && !NO_COMPANY.has(key) ? key : '';
};

const nameKey = (value: unknown): string => {
  const key = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return key.length >= 4 ? key : '';
};

/** Groups of record indexes, one group per customer. Every record lands in exactly one group. */
export function clusterCustomers(records: MatchRecord[]): number[][] {
  const parent = records.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 1–3: explicit links, then the same email or phone.
  const owner = new Map<string, number>();
  const strong = records.map(
    (r) =>
      [emailKey(r.identity.email) && `e:${emailKey(r.identity.email)}`, phoneKey(r.identity.phone) && `p:${phoneKey(r.identity.phone)}`].filter(
        Boolean,
      ) as string[],
  );
  records.forEach((record, i) => {
    for (const link of record.links ?? []) if (link >= 0 && link < records.length) union(i, link);
    for (const key of strong[i]) {
      const seen = owner.get(key);
      if (seen === undefined) owner.set(key, i);
      else union(i, seen);
    }
  });

  // 4–5: what is left has no email or phone anywhere in its group.
  const identified = new Set<number>();
  records.forEach((_, i) => strong[i].length > 0 && identified.add(find(i)));
  const companiesOf = new Map<string, Set<number>>();
  records.forEach((record, i) => {
    const root = find(i);
    const key = companyKey(record.identity.company);
    if (!key || !identified.has(root)) return;
    if (!companiesOf.has(key)) companiesOf.set(key, new Set());
    companiesOf.get(key)!.add(root);
  });
  // Records already linked to each other are placed together, as one.
  const looseGroups = new Map<number, number[]>();
  records.forEach((_, i) => {
    const root = find(i);
    if (identified.has(root)) return;
    if (!looseGroups.has(root)) looseGroups.set(root, []);
    looseGroups.get(root)!.push(i);
  });
  const loose = new Map<string, number>();
  for (const members of looseGroups.values()) {
    const companies = [...new Set(members.map((i) => companyKey(records[i].identity.company)).filter(Boolean))];
    const candidates = new Set<number>();
    for (const company of companies) for (const root of companiesOf.get(company) ?? []) candidates.add(find(root));
    if (candidates.size === 1) {
      union(members[0], [...candidates][0]);
      continue;
    }
    const name = members.map((i) => nameKey(records[i].identity.name)).find(Boolean);
    const key = companies[0] ? `c:${companies[0]}` : name ? `n:${name}` : '';
    if (!key) continue;
    const seen = loose.get(key);
    if (seen === undefined) loose.set(key, members[0]);
    else union(members[0], seen);
  }

  const groups = new Map<number, number[]>();
  records.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  });
  return [...groups.values()];
}
