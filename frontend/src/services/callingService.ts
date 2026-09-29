import { axiosClient } from '@/api/axiosClient';
import type { PlivoCallStatus, PlivoImportStatus } from './plivoService';

// Phone calls whichever carrier carries them (see backend/src/calling): Plivo for
// domestic (Indian) numbers, Twilio for international ones. One call button, one
// call log. Provider setup lives in plivoService / twilioService.

export type CallingProvider = 'plivo' | 'twilio';

export const PROVIDER_LABEL: Record<CallingProvider, string> = { plivo: 'Plivo', twilio: 'Twilio' };

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
}

export interface ProviderReadiness {
  connected: boolean;
  // Connected, reachable, and the signed-in person has an active line on it.
  ready: boolean;
  line: { businessNumber: string; agentPhone: string } | null;
}

export interface CallingOverview {
  canManage: boolean;
  domesticCountryCode: string;
  canCall: boolean;
  providers: Record<CallingProvider, ProviderReadiness>;
}

export const callingService = {
  async getOverview(): Promise<CallingOverview> {
    const { data } = await axiosClient.get<CallingOverview>('/calling/overview');
    return data;
  },

  // `customerNumber` with its country code (+447700900123). Leave `provider` out
  // to route automatically.
  async startCall(
    customerNumber: string,
    options: { dealId?: string; provider?: CallingProvider } = {},
  ): Promise<CallingCall> {
    const { data } = await axiosClient.post<CallingCall>('/calling/calls', {
      customerNumber,
      ...(options.dealId ? { dealId: options.dealId } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
    });
    return data;
  },

  async listCalls(scope: 'mine' | 'org' = 'mine'): Promise<CallingCall[]> {
    const { data } = await axiosClient.get<CallingCall[]>('/calling/calls', {
      params: scope === 'org' ? { scope } : {},
    });
    return data;
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
