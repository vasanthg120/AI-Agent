import { axiosClient } from '@/api/axiosClient';
import type { PlivoCallStatus, PlivoImportStatus } from './plivoService';

// Phone calls whichever carrier carries them (see backend/src/calling): Plivo for
// domestic (Indian) numbers, Twilio for international ones. One call button, one
// call log. Provider setup lives in plivoService / twilioService.

export type CallingProvider = 'plivo' | 'twilio';

export const PROVIDER_LABEL: Record<CallingProvider, string> = { plivo: 'Plivo', twilio: 'Twilio' };

// Where a call stands, in plain words — worked out by the server
// (backend/src/calling/call-outcome.ts) from what the carrier reported.
export type CallStage = 'ringing_agent' | 'connecting_customer' | 'in_call' | 'ended' | 'failed';
export type CallFailure =
  | 'busy'
  | 'no_answer_customer'
  | 'no_answer_agent'
  | 'invalid_number'
  | 'offline'
  | 'balance'
  | 'cancelled'
  | 'provider_error';

export interface CallOutcome {
  stage: CallStage;
  failure?: CallFailure;
  message: string;
}

// The call's Call Copilot report, once its recording has become a session.
export interface CallReport {
  sessionId: string;
  stage: 'transcribing' | 'scoring' | 'ready' | 'failed';
  overallScore?: number;
  headline?: string;
  // Ready, but the AI Coach never produced a score (it can be generated on demand).
  unscored?: boolean;
  error?: string;
}

// Why the server refused to start a call (the response's `code`).
export type StartRefusal =
  | 'invalid_number'
  | 'own_number'
  | 'no_line'
  | 'not_ready'
  | 'call_in_progress'
  | 'balance'
  | 'offline'
  | 'provider_error';

// Whether Plivo/Twilio can reach the server right now (the tunnel or domain is up).
export type Reachability = 'reachable' | 'unreachable' | 'unknown' | 'not_configured';

/** A customer the Dialer can call (GET /calling/contacts). */
export interface CallableCustomer {
  id: string;
  name: string;
  company?: string;
  // Each number as the CRM has it, with whose it is when not the customer's own.
  phones: { number: string; label?: string }[];
  // Their most recent open deal, so the call's report gets that context.
  deal?: { id: string; name?: string };
}

export interface CallingCall {
  id: string;
  provider: CallingProvider;
  direction: 'outbound' | 'inbound';
  customerNumber: string;
  // The Plivo / Twilio number the call went through.
  businessNumber: string;
  status: PlivoCallStatus;
  failureReason?: string;
  durationSeconds?: number;
  importStatus: PlivoImportStatus;
  importError?: string;
  sessionId?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  dealId?: string;
  // As picked from Contacts, or the linked deal's name.
  customerName?: string;
  // When the two sides were connected.
  answeredAt?: string;
  outcome?: CallOutcome;
  report?: CallReport;
}

export interface ProviderReadiness {
  connected: boolean;
  // Connected, the server has a public address for callbacks, and the signed-in
  // person has an active line on it.
  ready: boolean;
  // Whether the server has that public address (PLIVO_/TWILIO_PUBLIC_BASE_URL). Absent from older servers.
  publicUrlConfigured?: boolean;
  reachability?: Reachability;
  // The active line linked to the signed-in person — set even when `ready` is false.
  line: { businessNumber: string; agentPhone: string } | null;
}

export interface CallingOverview {
  canManage: boolean;
  domesticCountryCode: string;
  canCall: boolean;
  providers: Record<CallingProvider, ProviderReadiness>;
}

/**
 * Why the signed-in person can't place a call — one reading of the overview for
 * Call Copilot and the Dialer alike. A line can be linked to them while calling is
 * still off: that is `not_configured` (the server has no public address for the
 * carrier to call back on), never "no line".
 */
export type CallingBlocker = 'no_provider' | 'no_line' | 'not_configured';

const PROVIDERS: readonly CallingProvider[] = ['plivo', 'twilio'];

export interface LinkedLine {
  provider: CallingProvider;
  businessNumber: string;
  agentPhone: string;
}

/** The line linked to the signed-in person on a connected provider, ready or not. */
export function linkedLine(overview: CallingOverview): LinkedLine | null {
  for (const provider of PROVIDERS) {
    const { connected, line } = overview.providers[provider];
    if (connected && line) return { provider, ...line };
  }
  return null;
}

export function callingBlocker(overview: CallingOverview): CallingBlocker | null {
  if (overview.canCall) return null;
  if (!PROVIDERS.some((p) => overview.providers[p].connected)) return 'no_provider';
  return linkedLine(overview) ? 'not_configured' : 'no_line';
}

/** The server setting that gives this provider its public address. */
export const PUBLIC_URL_SETTING: Record<CallingProvider, string> = {
  plivo: 'PLIVO_PUBLIC_BASE_URL',
  twilio: 'TWILIO_PUBLIC_BASE_URL',
};

export const callingService = {
  async getOverview(): Promise<CallingOverview> {
    const { data } = await axiosClient.get<CallingOverview>('/calling/overview');
    return data;
  },

  /** The overview, asking afresh whether the phone network can reach the server. */
  async recheckOverview(): Promise<CallingOverview> {
    const { data } = await axiosClient.get<CallingOverview>('/calling/overview', { params: { recheck: 1 } });
    return data;
  },

  // `customerNumber` with its country code (+447700900123). Leave `provider` out
  // to route automatically.
  async startCall(
    customerNumber: string,
    // requestKey: one per tap of a call button — sent again (a retry), it returns the same call.
    options: { dealId?: string; provider?: CallingProvider; requestKey?: string; customerName?: string } = {},
  ): Promise<CallingCall> {
    const { data } = await axiosClient.post<CallingCall>('/calling/calls', {
      customerNumber,
      ...(options.dealId ? { dealId: options.dealId } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.requestKey ? { requestKey: options.requestKey } : {}),
      ...(options.customerName ? { customerName: options.customerName } : {}),
    });
    return data;
  },

  // `before` (an ISO time) pages back through older calls.
  async listCalls(scope: 'mine' | 'org' = 'mine', before?: string): Promise<CallingCall[]> {
    const { data } = await axiosClient.get<CallingCall[]>('/calling/calls', {
      params: { ...(scope === 'org' ? { scope } : {}), ...(before ? { before } : {}) },
    });
    return data;
  },

  /** One of my calls as it stands now, with the server's clock (for timing it). */
  async getCall(provider: CallingProvider, id: string): Promise<CallingCall & { serverTime: string }> {
    const { data } = await axiosClient.get<CallingCall & { serverTime: string }>(`/calling/calls/${provider}/${id}`);
    return data;
  },

  async searchContacts(search: string): Promise<CallableCustomer[]> {
    const { data } = await axiosClient.get<{ items: CallableCustomer[] }>('/calling/contacts', { params: { search } });
    return data.items;
  },

  async retryImport(call: Pick<CallingCall, 'provider' | 'id'>): Promise<CallingCall> {
    const { data } = await axiosClient.post<CallingCall>(`/calling/calls/${call.provider}/${call.id}/retry-import`);
    return data;
  },
};

/** Same rule as backend/src/calling/calling-routing.ts — so the "goes out via …"
 * preview is exactly what the server will do. */
export function chooseProvider(
  customerDigits: string,
  available: CallingProvider[],
  domesticCountryCode: string,
  requested?: CallingProvider,
): CallingProvider | null {
  if (requested) return available.includes(requested) ? requested : null;
  const domestic = customerDigits.startsWith(domesticCountryCode);
  const order: CallingProvider[] = domestic ? ['plivo', 'twilio'] : ['twilio', 'plivo'];
  return order.find((p) => available.includes(p)) ?? null;
}

// ---- countries ------------------------------------------------------------

export interface Country {
  iso: string;
  name: string;
  dialCode: string;
}

// The countries people most often call from here, then the rest alphabetically.
// Not exhaustive — "Other" lets anyone type a full +number.
export const COUNTRIES: Country[] = [
  { iso: 'IN', name: 'India', dialCode: '91' },
  { iso: 'US', name: 'United States', dialCode: '1' },
  { iso: 'GB', name: 'United Kingdom', dialCode: '44' },
  { iso: 'AE', name: 'United Arab Emirates', dialCode: '971' },
  { iso: 'SG', name: 'Singapore', dialCode: '65' },
  { iso: 'AU', name: 'Australia', dialCode: '61' },
  { iso: 'CA', name: 'Canada', dialCode: '1' },
  { iso: 'SA', name: 'Saudi Arabia', dialCode: '966' },
  { iso: 'DE', name: 'Germany', dialCode: '49' },
  { iso: 'BD', name: 'Bangladesh', dialCode: '880' },
  { iso: 'BE', name: 'Belgium', dialCode: '32' },
  { iso: 'BR', name: 'Brazil', dialCode: '55' },
  { iso: 'CH', name: 'Switzerland', dialCode: '41' },
  { iso: 'CN', name: 'China', dialCode: '86' },
  { iso: 'DK', name: 'Denmark', dialCode: '45' },
  { iso: 'EG', name: 'Egypt', dialCode: '20' },
  { iso: 'ES', name: 'Spain', dialCode: '34' },
  { iso: 'FR', name: 'France', dialCode: '33' },
  { iso: 'HK', name: 'Hong Kong', dialCode: '852' },
  { iso: 'ID', name: 'Indonesia', dialCode: '62' },
  { iso: 'IE', name: 'Ireland', dialCode: '353' },
  { iso: 'IL', name: 'Israel', dialCode: '972' },
  { iso: 'IT', name: 'Italy', dialCode: '39' },
  { iso: 'JP', name: 'Japan', dialCode: '81' },
  { iso: 'KE', name: 'Kenya', dialCode: '254' },
  { iso: 'KR', name: 'South Korea', dialCode: '82' },
  { iso: 'KW', name: 'Kuwait', dialCode: '965' },
  { iso: 'LK', name: 'Sri Lanka', dialCode: '94' },
  { iso: 'MX', name: 'Mexico', dialCode: '52' },
  { iso: 'MY', name: 'Malaysia', dialCode: '60' },
  { iso: 'NG', name: 'Nigeria', dialCode: '234' },
  { iso: 'NL', name: 'Netherlands', dialCode: '31' },
  { iso: 'NO', name: 'Norway', dialCode: '47' },
  { iso: 'NP', name: 'Nepal', dialCode: '977' },
  { iso: 'NZ', name: 'New Zealand', dialCode: '64' },
  { iso: 'OM', name: 'Oman', dialCode: '968' },
  { iso: 'PH', name: 'Philippines', dialCode: '63' },
  { iso: 'PK', name: 'Pakistan', dialCode: '92' },
  { iso: 'PL', name: 'Poland', dialCode: '48' },
  { iso: 'PT', name: 'Portugal', dialCode: '351' },
  { iso: 'QA', name: 'Qatar', dialCode: '974' },
  { iso: 'SE', name: 'Sweden', dialCode: '46' },
  { iso: 'TH', name: 'Thailand', dialCode: '66' },
  { iso: 'TR', name: 'Türkiye', dialCode: '90' },
  { iso: 'VN', name: 'Vietnam', dialCode: '84' },
  { iso: 'ZA', name: 'South Africa', dialCode: '27' },
];

// Windows has no flag emoji — it draws the two letters instead ("GB"), which
// reads as a typo inside text. There, text gets no flag and the <Flag> badge
// shows the country code on its own.
export const FLAG_EMOJI_SUPPORTED = typeof navigator === 'undefined' || !/Windows/i.test(navigator.userAgent);

/** 🇬🇧 from "GB" (flag emoji are two regional-indicator letters); '' where the
 * platform can't draw flags. */
export function flagOf(iso: string): string {
  if (!FLAG_EMOJI_SUPPORTED) return '';
  return iso.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65));
}

/** The flag followed by a space, for putting in front of text — or nothing. */
export function flagPrefix(iso: string): string {
  const flag = flagOf(iso);
  return flag ? `${flag} ` : '';
}

/** The country a full number (digits with country code) belongs to — longest
 * dial-code match, so +971 is the UAE, not a +97… guess. */
export function countryOfNumber(digits: string): Country | null {
  let best: Country | null = null;
  for (const country of COUNTRIES) {
    if (digits.startsWith(country.dialCode) && (!best || country.dialCode.length > best.dialCode.length))
      best = country;
  }
  return best;
}

/** "+44 7700 900123"-style display: the country code set apart, the rest as typed digits. */
export function formatInternational(digits: string): string {
  const country = countryOfNumber(digits);
  if (!country) return /^\d{8,15}$/.test(digits) ? `+${digits}` : digits;
  const national = digits.slice(country.dialCode.length);
  return `+${country.dialCode} ${national.replace(/(\d{3,4})(?=(\d{3,4})+$)/g, '$1 ')}`.trim();
}
