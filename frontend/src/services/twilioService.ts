import { axiosClient } from '@/api/axiosClient';

// Twilio setup (see backend/src/twilio) — owners and admins only. Placing calls
// and the call log go through callingService.

export interface TwilioLine {
  id: string;
  // Digits only, country code included.
  twilioNumber: string;
  numberSid?: string;
  userId: string;
  userName: string;
  agentPhone: string;
  languageCode: string;
  label?: string;
  announceRecording: boolean;
  active: boolean;
}

export interface TwilioConfig {
  connected: boolean;
  accountSidMasked?: string;
  // Read live from Twilio; null when it couldn't be read just now.
  account?: { friendlyName?: string; type?: string; status?: string } | null;
  webhookUrls: { voice: string; status: string } | null;
  publicUrlConfigured: boolean;
  lines: TwilioLine[];
}

export interface TwilioNumber {
  sid: string;
  number: string;
  friendlyName: string;
  voiceCapable: boolean;
  voiceUrl: string;
  pointsToHaive: boolean;
  lineId?: string;
}

export interface SaveTwilioLinePayload {
  twilioNumber: string;
  userId: string;
  agentPhone: string;
  languageCode?: string;
  announceRecording?: boolean;
  active?: boolean;
}

export const twilioService = {
  async getConfig(): Promise<TwilioConfig> {
    const { data } = await axiosClient.get<TwilioConfig>('/twilio/config');
    return data;
  },

  // Checked with Twilio before it is saved.
  async connect(accountSid: string, authToken: string): Promise<void> {
    await axiosClient.post('/twilio/connect', { accountSid, authToken });
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/twilio/connect');
  },

  async listNumbers(): Promise<TwilioNumber[]> {
    const { data } = await axiosClient.get<TwilioNumber[]>('/twilio/numbers');
    return data;
  },

  async configureNumber(sid: string): Promise<TwilioNumber[]> {
    const { data } = await axiosClient.post<TwilioNumber[]>(`/twilio/numbers/${sid}/configure`);
    return data;
  },

  // Also points the number's incoming calls at HaiVE.
  async saveLine(payload: SaveTwilioLinePayload): Promise<TwilioLine[]> {
    const { data } = await axiosClient.put<TwilioLine[]>('/twilio/lines', payload);
    return data;
  },

  async deleteLine(id: string): Promise<TwilioLine[]> {
    const { data } = await axiosClient.delete<TwilioLine[]>(`/twilio/lines/${id}`);
    return data;
  },
};

export const isTrialAccount = (config: TwilioConfig | undefined) => config?.account?.type?.toLowerCase() === 'trial';
