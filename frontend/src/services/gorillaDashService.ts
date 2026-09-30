import { axiosClient } from '@/api/axiosClient';

// Connecting Gorilla Dash (see backend/src/gorilladash). Once connected it is
// a CRM data source (enquiries + people) and the AI's Gorilla Dash tools work.

export interface GorillaDashStatus {
  connected: boolean;
  keyMasked?: string;
  // An organisation key sees every location; a location key only its own.
  keyScope?: 'organization' | 'location' | 'unknown';
}

export const gorillaDashService = {
  async getStatus(): Promise<GorillaDashStatus> {
    const { data } = await axiosClient.get<GorillaDashStatus>('/gorilladash/status');
    return data;
  },

  // Checked with Gorilla Dash before anything is saved.
  async connect(apiKey: string, apiSecret: string): Promise<GorillaDashStatus> {
    const { data } = await axiosClient.post<GorillaDashStatus>('/gorilladash/connect', { apiKey, apiSecret });
    return data;
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/gorilladash/connect');
  },
};
