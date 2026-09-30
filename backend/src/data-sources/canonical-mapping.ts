// TypeScript twin of python-agent/app/integrations/crm_adapters.py's mapping
// helpers (get_path / to_canonical / map_status / field_paths), for records
// that are pushed to HaiVE (webhook sources) rather than pulled by the sync.
// Keep the two in step: a record must mean the same thing whichever way it came.
import { CANONICAL_FIELDS, MirroredModule, StatusMapping } from './provider-catalog';

export type RawRecord = Record<string, unknown>;

/** Value at a dotted path ("properties.amount", "customer.name"), or undefined. */
export function getPath(record: RawRecord, path: string | undefined): unknown {
  if (!path) return undefined;
  let value: unknown = record;
  for (const part of path.split('.')) {
    if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as RawRecord)[part];
    else return undefined;
  }
  return value;
}

/** One record as HaiVE's canonical fields — only the mapped ones. */
export function toCanonical(record: RawRecord, mapping: Record<string, string> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(mapping ?? {})) if (path) out[field] = getPath(record, path);
  return out;
}

/** open / won / lost from the CRM's own status value (exact match first, then contained; lost before won). */
export function mapStatus(raw: unknown, mapping: StatusMapping | undefined): 'open' | 'won' | 'lost' {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value) return 'open';
  const clean = (list: string[] | undefined) => (list ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  const won = clean(mapping?.won);
  const lost = clean(mapping?.lost);
  if (won.includes(value)) return 'won';
  if (lost.includes(value)) return 'lost';
  if (lost.some((v) => v.length >= 3 && value.includes(v))) return 'lost';
  if (won.some((v) => v.length >= 3 && value.includes(v))) return 'won';
  return 'open';
}

/** Every dotted field path on a record (two levels deep). */
export function fieldPaths(record: RawRecord, prefix = '', depth = 0): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const path = `${prefix}${key}`;
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 2) paths.push(...fieldPaths(value as RawRecord, `${path}.`, depth + 1));
    else paths.push(path);
  }
  return paths;
}

export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  const date = /^\d{12,}$/.test(text) ? new Date(Number(text)) : /^\d{9,11}$/.test(text) ? new Date(Number(text) * 1000) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "YYYY-MM-DD", or null. */
export function toDay(value: unknown): string | null {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Field names people type into a Zap ("Customer Name", "job.total ($)")
 * made into mappable paths ("Customer_Name", "job_total"): letters, digits
 * and underscores only, nested objects kept (two levels deep). */
export function cleanKeys(record: RawRecord, depth = 0): RawRecord {
  const out: RawRecord = {};
  for (const [key, value] of Object.entries(record)) {
    const clean =
      key
        .trim()
        .replace(/[^\w$-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^(\d)/, '_$1') || 'field';
    out[clean] = value && typeof value === 'object' && !Array.isArray(value) && depth < 2 ? cleanKeys(value as RawRecord, depth + 1) : value;
  }
  return out;
}

const DISPLAY_NAME = '_display_name';

/** Adds `_display_name` — the record's best human name — so apps that send
 * first and last name separately still map onto HaiVE's single name field. */
export function withDisplayName(record: RawRecord): RawRecord {
  const text = (key: string) => {
    const hit = Object.entries(record).find(([k]) => normalizeKey(k) === key);
    return hit && (typeof hit[1] === 'string' || typeof hit[1] === 'number') ? String(hit[1]).trim() : '';
  };
  const person = [text('firstname'), text('lastname')].filter(Boolean).join(' ');
  const name =
    text('name') ||
    text('fullname') ||
    text('displayname') ||
    text('customername') ||
    text('title') ||
    person ||
    text('companyname') ||
    text('businessname') ||
    text('email');
  return name ? { ...record, [DISPLAY_NAME]: name } : record;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Common names apps give each canonical field, most specific first.
const GUESSES: Record<string, string[]> = {
  externalId: ['id', 'recordid', 'externalid', 'uuid', 'customerid', 'jobid', 'dealid', 'contactid', 'companyid', 'accountid', 'leadid', 'enquiryid'],
  name: [normalizeKey(DISPLAY_NAME)],
  email: ['email', 'emailaddress', 'primaryemail', 'customeremail', 'contactemail'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'telephone', 'customerphone', 'contactphone'],
  company: ['company', 'companyname', 'businessname', 'organisation', 'organization', 'account', 'accountname'],
  domain: ['domain', 'website', 'websiteurl', 'url'],
  amount: ['amount', 'value', 'total', 'totalamount', 'price', 'dealvalue', 'jobvalue', 'quotetotal', 'revenue'],
  status: ['status', 'dealstatus', 'jobstatus', 'state', 'stage'],
  stage: ['stage', 'pipelinestage', 'dealstage', 'status'],
  pipeline: ['pipeline', 'pipelinename'],
  closeDate: ['closedate', 'closingdate', 'expectedclosedate', 'duedate', 'completedat', 'completiondate', 'enddate'],
  owner: ['owner', 'ownerid', 'assignedto', 'assignee', 'salesperson', 'user'],
  createdAt: ['createdat', 'created', 'datecreated', 'createdtime', 'createddate', 'createdon'],
};

/** A first field mapping from one sample record: for each canonical field of
 * the module, the record's field whose name looks like it (top-level fields
 * win over nested ones). Only a starting point — administrators can change it. */
export function guessMappings(module: MirroredModule, sample: RawRecord): Record<string, string> {
  const paths = fieldPaths(withDisplayName(sample)).sort((a, b) => a.split('.').length - b.split('.').length);
  const byName = new Map<string, string>();
  for (const path of paths) {
    const last = normalizeKey(path.split('.').pop() ?? '');
    if (!byName.has(last)) byName.set(last, path);
  }
  const mapping: Record<string, string> = {};
  for (const { key } of CANONICAL_FIELDS[module]) {
    const hit = (GUESSES[key] ?? []).map((g) => byName.get(g)).find(Boolean);
    if (hit) mapping[key] = hit;
  }
  return mapping;
}
