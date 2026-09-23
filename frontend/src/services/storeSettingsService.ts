import { axiosClient } from '@/api/axiosClient';

export interface StoreSettings {
  openingTime: string; // "HH:mm", 24-hour
  closingTime: string;
  timezone: string; // IANA zone, e.g. "Asia/Kolkata"
}

export const storeSettingsService = {
  async getSettings(): Promise<StoreSettings> {
    const { data } = await axiosClient.get<StoreSettings>('/store-settings');
    return data;
  },

  async updateSettings(settings: StoreSettings): Promise<StoreSettings> {
    const { data } = await axiosClient.put<StoreSettings>('/store-settings', settings);
    return data;
  },

  // Manual trigger for the scheduled morning/EOD report job — admin-only on
  // the backend (StoreSettingsController's own @Roles('admin')), scoped to
  // the caller's own store. Surfaced on the TODO/EOD empty states so an
  // admin doesn't have to wait for the store's opening/closing-time window.
  async runNow(type: 'morning' | 'eod'): Promise<{ usersNotified: number; totalUsers: number }> {
    const { data } = await axiosClient.post<{ usersNotified: number; totalUsers: number }>('/store-settings/run-now', undefined, {
      params: { type },
    });
    return data;
  },
};
