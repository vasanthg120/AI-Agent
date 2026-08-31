import { adminAxiosClient } from '@/api/adminAxiosClient';

// Haive-internal — Plans/Features/Prices/Currencies/Taxes/Coupons admin CRUD.
// Every method hits an already-existing @Roles('platform_admin') route built
// in earlier phases of this project (billing-admin-plans/-currencies/-taxes/
// -coupons.controller.ts) — this file is purely the frontend wrapper, no new
// backend logic.

export interface AdminFeatureGrant {
  featureKey: string;
  enabled: boolean;
  valueOverride?: string;
}

export interface AdminLimitGrant {
  limitKey: string;
  unlimited: boolean;
  value?: number;
}

// Phase 0 of the ChatGPT-style entitlements migration — additive, parallel
// to AdminFeatureGrant/AdminLimitGrant above.
export interface AdminEntitlementGrant {
  key: string;
  enabled: boolean;
  value?: number;
}

export interface AdminEntitlement {
  _id: string;
  key: string;
  name: string;
  type: 'boolean' | 'numeric';
  description?: string;
  active: boolean;
}

export interface AdminCreditPackage {
  _id: string;
  key: string;
  name: string;
  credits: number;
  bonusCredits: number;
  price: number;
  currency: string;
  active: boolean;
  sortOrder: number;
}

export interface AdminPlan {
  _id: string;
  key: string;
  name: string;
  description?: string;
  shortDescription?: string;
  internalDescription?: string;
  icon?: string;
  image?: string;
  badgeText?: string;
  badgeColor?: string;
  planColor?: string;
  sortOrder: number;
  active: boolean;
  isPublic: boolean;
  recommended: boolean;
  trialDays?: number;
  features: AdminFeatureGrant[];
  limits: AdminLimitGrant[];
  entitlements: AdminEntitlementGrant[];
}

export interface AdminPlanPrice {
  _id: string;
  planId: string;
  currencyCode: string;
  billingCycle: 'monthly' | 'yearly' | 'weekly' | 'quarterly' | 'one_time';
  amount: number;
  creditsGranted: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

export interface AdminFeature {
  _id: string;
  key: string;
  name: string;
  description?: string;
  category?: string;
  active: boolean;
}

export interface AdminCurrency {
  _id: string;
  code: string;
  name: string;
  symbol: string;
  decimalDigits: number;
  symbolPosition: 'before' | 'after';
  usdToCurrencyRate: number;
  isDefault: boolean;
  active: boolean;
}

export interface AdminTaxRate {
  _id: string;
  key: string;
  name: string;
  percentage: number;
  countryCode?: string;
  region?: string;
  inclusive: boolean;
  active: boolean;
}

export interface AdminCoupon {
  _id: string;
  code: string;
  type: 'percentage' | 'fixed_amount' | 'free_credits';
  value: number;
  currencyCode?: string;
  description?: string;
  appliesTo: 'all' | 'plans' | 'packages';
  applicablePlanIds: string[];
  validFrom?: string;
  validTo?: string;
  maxRedemptions?: number;
  maxRedemptionsPerOrg: number;
  active: boolean;
}

export const billingCatalogAdminService = {
  // --- Plans ---
  listPlans: async (): Promise<AdminPlan[]> => (await adminAxiosClient.get('/billing/admin/plans')).data,
  getPlan: async (id: string): Promise<AdminPlan> => (await adminAxiosClient.get(`/billing/admin/plans/${id}`)).data,
  createPlan: async (dto: Partial<AdminPlan>): Promise<AdminPlan> => (await adminAxiosClient.post('/billing/admin/plans', dto)).data,
  updatePlan: async (id: string, dto: Partial<AdminPlan>): Promise<AdminPlan> => (await adminAxiosClient.patch(`/billing/admin/plans/${id}`, dto)).data,
  archivePlan: async (id: string): Promise<AdminPlan> => (await adminAxiosClient.post(`/billing/admin/plans/${id}/archive`)).data,
  activatePlan: async (id: string): Promise<AdminPlan> => (await adminAxiosClient.post(`/billing/admin/plans/${id}/activate`)).data,
  duplicatePlan: async (id: string, key: string): Promise<AdminPlan> => (await adminAxiosClient.post(`/billing/admin/plans/${id}/duplicate`, { key })).data,
  reorderPlans: async (orderedIds: string[]): Promise<void> => {
    await adminAxiosClient.post('/billing/admin/plans/reorder', { orderedIds });
  },
  // Permanent delete — the backend rejects this with a 400 if the plan has
  // any subscription history, so this can safely be offered next to Archive
  // without risking an org's billing history pointing at a deleted plan.
  deletePlan: async (id: string): Promise<void> => {
    await adminAxiosClient.delete(`/billing/admin/plans/${id}`);
  },

  // --- Plan prices ---
  listPrices: async (planId: string): Promise<AdminPlanPrice[]> => (await adminAxiosClient.get(`/billing/admin/plans/${planId}/prices`)).data,
  addPrice: async (planId: string, dto: { currencyCode: string; billingCycle: string; amount: number; creditsGranted: number }): Promise<AdminPlanPrice> =>
    (await adminAxiosClient.post(`/billing/admin/plans/${planId}/prices`, dto)).data,
  removePrice: async (priceId: string): Promise<void> => {
    await adminAxiosClient.delete(`/billing/admin/plan-prices/${priceId}`);
  },

  // --- Features ---
  listFeatures: async (): Promise<AdminFeature[]> => (await adminAxiosClient.get('/billing/admin/features')).data,
  createFeature: async (dto: Partial<AdminFeature>): Promise<AdminFeature> => (await adminAxiosClient.post('/billing/admin/features', dto)).data,
  updateFeature: async (id: string, dto: Partial<AdminFeature>): Promise<AdminFeature> => (await adminAxiosClient.patch(`/billing/admin/features/${id}`, dto)).data,

  // --- Entitlements (Phase 0 of the ChatGPT-style billing migration) ---
  listEntitlements: async (): Promise<AdminEntitlement[]> => (await adminAxiosClient.get('/billing/admin/entitlements')).data,
  createEntitlement: async (dto: Partial<AdminEntitlement>): Promise<AdminEntitlement> => (await adminAxiosClient.post('/billing/admin/entitlements', dto)).data,
  updateEntitlement: async (id: string, dto: Partial<AdminEntitlement>): Promise<AdminEntitlement> =>
    (await adminAxiosClient.patch(`/billing/admin/entitlements/${id}`, dto)).data,
  activateEntitlement: async (id: string): Promise<AdminEntitlement> => (await adminAxiosClient.post(`/billing/admin/entitlements/${id}/activate`)).data,
  deactivateEntitlement: async (id: string): Promise<AdminEntitlement> => (await adminAxiosClient.post(`/billing/admin/entitlements/${id}/deactivate`)).data,

  // --- Currencies ---
  listCurrencies: async (): Promise<AdminCurrency[]> => (await adminAxiosClient.get('/billing/admin/currencies')).data,
  createCurrency: async (dto: Partial<AdminCurrency>): Promise<AdminCurrency> => (await adminAxiosClient.post('/billing/admin/currencies', dto)).data,
  updateCurrency: async (id: string, dto: Partial<AdminCurrency>): Promise<AdminCurrency> => (await adminAxiosClient.patch(`/billing/admin/currencies/${id}`, dto)).data,
  activateCurrency: async (id: string): Promise<AdminCurrency> => (await adminAxiosClient.post(`/billing/admin/currencies/${id}/activate`)).data,
  deactivateCurrency: async (id: string): Promise<AdminCurrency> => (await adminAxiosClient.post(`/billing/admin/currencies/${id}/deactivate`)).data,

  // --- Tax rates ---
  listTaxRates: async (): Promise<AdminTaxRate[]> => (await adminAxiosClient.get('/billing/admin/taxes')).data,
  createTaxRate: async (dto: Partial<AdminTaxRate>): Promise<AdminTaxRate> => (await adminAxiosClient.post('/billing/admin/taxes', dto)).data,
  updateTaxRate: async (id: string, dto: Partial<AdminTaxRate>): Promise<AdminTaxRate> => (await adminAxiosClient.patch(`/billing/admin/taxes/${id}`, dto)).data,
  activateTaxRate: async (id: string): Promise<AdminTaxRate> => (await adminAxiosClient.post(`/billing/admin/taxes/${id}/activate`)).data,
  deactivateTaxRate: async (id: string): Promise<AdminTaxRate> => (await adminAxiosClient.post(`/billing/admin/taxes/${id}/deactivate`)).data,

  // --- Credit Packages (one-time "Add Credits" catalog) ---
  listPackages: async (): Promise<AdminCreditPackage[]> => (await adminAxiosClient.get('/billing/admin/packages')).data,
  createPackage: async (dto: Partial<AdminCreditPackage>): Promise<AdminCreditPackage> => (await adminAxiosClient.post('/billing/admin/packages', dto)).data,
  updatePackage: async (id: string, dto: Partial<AdminCreditPackage>): Promise<AdminCreditPackage> => (await adminAxiosClient.patch(`/billing/admin/packages/${id}`, dto)).data,
  activatePackage: async (id: string): Promise<AdminCreditPackage> => (await adminAxiosClient.post(`/billing/admin/packages/${id}/activate`)).data,
  deactivatePackage: async (id: string): Promise<AdminCreditPackage> => (await adminAxiosClient.post(`/billing/admin/packages/${id}/deactivate`)).data,

  // --- Coupons ---
  listCoupons: async (): Promise<AdminCoupon[]> => (await adminAxiosClient.get('/billing/admin/coupons')).data,
  createCoupon: async (dto: Partial<AdminCoupon>): Promise<AdminCoupon> => (await adminAxiosClient.post('/billing/admin/coupons', dto)).data,
  updateCoupon: async (id: string, dto: Partial<AdminCoupon>): Promise<AdminCoupon> => (await adminAxiosClient.patch(`/billing/admin/coupons/${id}`, dto)).data,
  activateCoupon: async (id: string): Promise<AdminCoupon> => (await adminAxiosClient.post(`/billing/admin/coupons/${id}/activate`)).data,
  deactivateCoupon: async (id: string): Promise<AdminCoupon> => (await adminAxiosClient.post(`/billing/admin/coupons/${id}/deactivate`)).data,
};
