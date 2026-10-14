// One clean shape for an enquiry, whichever CRM it came from. The sync keeps
// each CRM's original record whole (`sourceData`); a normalizer picks out what
// a salesperson needs and leaves the rest — internal ids, slugs, tracking
// parameters, submit URLs, timestamps of the record itself — behind. Nothing
// raw reaches the API.
//
// Adding a CRM that delivers enquiries = adding one entry to NORMALIZERS (and
// its provider id is then picked up as an enquiry source automatically).

export interface NamedValue {
  name: string;
  value: string;
}

export interface NormalizedEnquiry {
  person: { name: string; company?: string; email?: string; phone?: string; address?: string };
  /** A stable key for "the same customer": their email, else their phone. */
  customerKey?: string;
  /** What the customer wrote on the form, in their words. */
  message: NamedValue[];
  form?: string;
  channel?: string;
  location?: string;
  updatedAt?: Date;
}

type Raw = Record<string, any>;

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
// Values a form sends when nothing was entered.
const EMPTY = new Set(['', '-', '—', '–', 'n/a', 'na', 'none', 'null', 'undefined', 'nil', '.']);
const meaningful = (value: string) => !EMPTY.has(value.toLowerCase());
const date = (value: unknown): Date | undefined => {
  const parsed = typeof value === 'string' || value instanceof Date ? new Date(value) : undefined;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
};

/**
 * The customer's own answers, cleaned: empty and placeholder answers dropped,
 * and anything that only repeats what is already shown as the customer's
 * name, company, email, phone or address left out (a "Business Name" field
 * next to the company, an "Email" field next to the email).
 */
export function cleanMessage(fields: unknown, known: (string | undefined)[]): NamedValue[] {
  if (!Array.isArray(fields)) return [];
  const already = new Set(known.map((k) => (k ?? '').trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const out: NamedValue[] = [];
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    const name = text((field as Raw).name ?? (field as Raw).label ?? (field as Raw).parameter);
    const value = text((field as Raw).value);
    if (!name || !meaningful(value) || already.has(value.toLowerCase())) continue;
    const key = `${name.toLowerCase()}|${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value });
  }
  return out;
}

function gorillaDash(raw: Raw, deal: Raw): NormalizedEnquiry {
  const person = (raw.person ?? {}) as Raw;
  const name = [text(person.first_name), text(person.last_name)].filter(Boolean).join(' ') || text(deal.name) || 'Unknown';
  const company = text(person.business_name) || undefined;
  const email = text(person.email) || undefined;
  const phone = text(person.number_display) || text(person.number_e164) || undefined;
  const address =
    ['address_1', 'address_2', 'locality', 'state', 'postal_code', 'country']
      .map((k) => text(person[k]))
      .filter(meaningful)
      .join(', ') || undefined;
  return {
    person: { name, company, email, phone, address },
    customerKey: email?.toLowerCase() || text(person.number_e164) || undefined,
    message: cleanMessage(raw.fields, [name, company, email, phone, text(person.number_e164), address]),
    form: text(raw.enquiry_form?.name) || undefined,
    channel: text(raw.calculated_source) || undefined,
    location: text(raw.tribe?.name) || undefined,
    updatedAt: date(raw.updated_at),
  };
}

/** A CRM with no dedicated normalizer: only HaiVE's own canonical fields are used. */
function generic(_raw: Raw, deal: Raw): NormalizedEnquiry {
  return { person: { name: text(deal.name) || 'Unknown' }, message: [], channel: text(deal.leadSource) || undefined, location: text(deal.region) || undefined };
}

const NORMALIZERS: Record<string, (raw: Raw, deal: Raw) => NormalizedEnquiry> = {
  gorilladash: gorillaDash,
};

/** CRMs whose synced deals are enquiries (leads), by provider id. */
export const ENQUIRY_PROVIDERS = Object.keys(NORMALIZERS);

export function normalizeEnquiry(provider: string, deal: Raw): NormalizedEnquiry {
  const raw = (deal.sourceData ?? {}) as Raw;
  return (NORMALIZERS[provider] ?? generic)(raw, deal);
}
