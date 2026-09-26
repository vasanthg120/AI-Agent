import { axiosClient } from '@/api/axiosClient';

// Phone calls through Plivo, recorded and fed into Call Copilot (see
// backend/src/plivo). The browser never sees the Auth Token or a recording URL —
// only what it needs to show: whether Plivo is connected, who has a line, and how
// each call is going.

export interface PlivoLine {
  id: string;
  // Digits only, country code included (919876543210).
  plivoNumber: string;
  userId: string;
  userName: string;
  // The agent's real phone — the one Plivo rings.
  agentPhone: string;
  languageCode: string;
  label?: string;
  active: boolean;
}

export interface PlivoConfig {
  connected: boolean;
  // First and last characters of the Auth ID only.
  authIdMasked?: string;
  canManage: boolean;
  // Where Plivo must be pointed — only sent to owners/admins, and null until the
  // server has a public address.
  webhookUrls: { answer: string; hangup: string } | null;
  publicUrlConfigured: boolean;
  defaultCountryCode: string;
  // An admin gets every line; anyone else just their own.
  lines: PlivoLine[];
  // Whether the signed-in user can place a call right now.
  canCall: boolean;
}

export type PlivoCallStatus = 'initiated' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'cancelled';
// The recording's journey into Call Library: none (no recording) -> pending
// (being fetched and transcribed) -> imported, or failed (can be retried).
export type PlivoImportStatus = 'none' | 'pending' | 'imported' | 'failed';

export interface PlivoCall {
  id: string;
  direction: 'outbound' | 'inbound';
  customerNumber: string;
  plivoNumber: string;
  status: PlivoCallStatus;
  failureReason?: string;
  durationSeconds?: number;
  importStatus: PlivoImportStatus;
  importError?: string;
  // The Call Copilot session made from the recording — present once imported.
  sessionId?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveLinePayload {
  plivoNumber: string;
  userId: string;
  agentPhone: string;
  languageCode?: string;
  label?: string;
  active?: boolean;
}

export const plivoService = {
  async getConfig(): Promise<PlivoConfig> {
    const { data } = await axiosClient.get<PlivoConfig>('/plivo/config');
    return data;
  },

  // Verifies the pair with Plivo before saving it, so a typo fails here with a
  // clear message rather than on the first customer call.
  async connect(authId: string, authToken: string): Promise<void> {
    await axiosClient.post('/plivo/connect', { authId, authToken });
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/plivo/connect');
  },

  async saveLine(payload: SaveLinePayload): Promise<PlivoLine[]> {
    const { data } = await axiosClient.put<PlivoLine[]>('/plivo/lines', payload);
    return data;
  },

  async deleteLine(id: string): Promise<PlivoLine[]> {
    const { data } = await axiosClient.delete<PlivoLine[]>(`/plivo/lines/${id}`);
    return data;
  },

  // Click-to-call: Plivo rings the agent's phone, and when it is answered dials
  // the customer, recording the conversation.
  async startCall(customerNumber: string, dealId?: string): Promise<PlivoCall> {
    const { data } = await axiosClient.post<PlivoCall>('/plivo/calls', {
      customerNumber,
      ...(dealId ? { dealId } : {}),
    });
    return data;
  },

  // The signed-in user's own calls; an owner/admin can ask for the whole organization's.
  async listCalls(scope: 'mine' | 'org' = 'mine'): Promise<PlivoCall[]> {
    const { data } = await axiosClient.get<PlivoCall[]>('/plivo/calls', { params: scope === 'org' ? { scope } : {} });
    return data;
  },

  // Try again to turn a recording into a Call Library entry (e.g. after topping up credits).
  async retryImport(id: string): Promise<PlivoCall> {
    const { data } = await axiosClient.post<PlivoCall>(`/plivo/calls/${id}/retry-import`);
    return data;
  },
};

// A call still marked live long after Plivo's own 4-hour call limit never got its
// hangup report — it is over, and nothing is left to wait for.
const STALE_CALL_AFTER_MS = 5 * 60 * 60_000;
// An import is a few minutes of work; one untouched for this long was lost (e.g.
// the server restarted mid-way), and can be retried.
const STUCK_IMPORT_AFTER_MS = 15 * 60_000;

export function isCallStale(call: PlivoCall): boolean {
  return (
    (call.status === 'initiated' || call.status === 'in_progress') &&
    Date.now() - new Date(call.createdAt).getTime() > STALE_CALL_AFTER_MS
  );
}

export function isImportStuck(call: PlivoCall): boolean {
  return call.importStatus === 'pending' && Date.now() - new Date(call.updatedAt).getTime() > STUCK_IMPORT_AFTER_MS;
}

// A call is "live" while it is being set up or connected, or while its recording
// is still being turned into a summary — the states worth polling for.
export function isCallActive(call: PlivoCall): boolean {
  if (isCallStale(call) || isImportStuck(call)) return false;
  return call.status === 'initiated' || call.status === 'in_progress' || call.importStatus === 'pending';
}

export const CALL_STATUS_LABEL: Record<PlivoCallStatus, string> = {
  initiated: 'Calling your phone…',
  in_progress: 'On the call',
  completed: 'Call ended',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Could not connect',
  cancelled: 'Cancelled',
};

/** "98 76 54 32 10"-style grouping is not worth guessing across countries — just
 * put a plus in front of the digits so it reads as an international number. */
export function formatPhone(digits: string): string {
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : digits;
}

export function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds < 1) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
