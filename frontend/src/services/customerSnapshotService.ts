import { axiosClient } from '@/api/axiosClient';
import type { BadgeVariant } from '@/components/ui';

// The customer on a call, in a few lines — backend Customer360Service.snapshot.
export type CustomerSnapshot =
  | { found: false }
  | { found: true; restricted: true }
  | {
      found: true;
      restricted?: false;
      customer: { id: string; name: string; company?: string };
      currency: string;
      stage: { label: string; tone: BadgeVariant; reason: string };
      flags: { key: string; label: string; tone: BadgeVariant; reason: string }[];
      orders: number;
      revenue: number;
      openQuotes: number;
      openQuoteValue: number;
      lastContactAt?: string;
      health: { score: number | null; band: string; label: string };
      unansweredEmails: number;
      lastCall?: { at: string; summary?: string };
      nextSteps: string[];
    };

export const customerSnapshotService = {
  async get(ref: { dealId?: string; phone?: string }): Promise<CustomerSnapshot> {
    const params: Record<string, string> = {};
    if (ref.dealId) params.dealId = ref.dealId;
    if (ref.phone) params.phone = ref.phone;
    const { data } = await axiosClient.get<CustomerSnapshot>('/call-copilot/customer-snapshot', { params });
    return data;
  },
};
