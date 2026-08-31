import { adminAxiosClient } from '@/api/adminAxiosClient';

export interface BillingSettings {
  companyName: string;
  companyLogoUrl?: string;
  companyAddress?: string;
  companyEmail?: string;
  companyPhone?: string;
  companyWebsite?: string;
  companyTaxId?: string;
  invoiceNumberPrefix: string;
  invoiceNumberStart: number;
  invoiceFooterText?: string;
  invoiceTermsText?: string;
  defaultPaymentProvider?: string;
  defaultPaymentMode?: 'live' | 'test';
  defaultCurrencyCode?: string;
  enabledGateways?: string[];
  autoRechargeMinCredits?: number;
  autoRechargeMaxCredits?: number;
  autoRechargeDefaultOn?: boolean;
}

// GET/PUT of the single BillingSettings singleton — see
// backend/src/billing/schemas/billing-settings.schema.ts's comment on why
// the payment-settings fields (defaultPaymentProvider/enabledGateways/
// autoRecharge bounds) are stored/returned only, not yet enforced anywhere.
export const billingSettingsAdminService = {
  async get(): Promise<BillingSettings> {
    const { data } = await adminAxiosClient.get<BillingSettings>('/billing/admin/settings');
    return data;
  },

  async update(dto: Partial<BillingSettings>): Promise<BillingSettings> {
    const { data } = await adminAxiosClient.put<BillingSettings>('/billing/admin/settings', dto);
    return data;
  },
};
