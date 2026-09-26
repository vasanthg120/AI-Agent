export const DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const FALLBACK_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

// Every IANA zone the browser knows, grouped by region ("Asia", "Europe"…)
// for <optgroup>s. Falls back to a short list where Intl.supportedValuesOf is
// missing. Computed once — the list never changes at runtime.
function buildGroups(): [string, string[]][] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = FALLBACK_ZONES;
  if (!zones.includes('UTC')) zones = [...zones, 'UTC'];
  const groups = new Map<string, string[]>();
  for (const z of zones) {
    const region = z.includes('/') ? z.split('/')[0] : 'Other';
    groups.set(region, [...(groups.get(region) ?? []), z]);
  }
  return [...groups.entries()];
}

export const TIMEZONE_GROUPS = buildGroups();

export function isKnownTimezone(zone: string): boolean {
  return TIMEZONE_GROUPS.some(([, zones]) => zones.includes(zone));
}

// "3:42 PM" in the given zone, or "—" for an invalid zone name.
export function timeIn(zone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(now);
  } catch {
    return '—';
  }
}
