import { axiosClient } from '@/api/axiosClient';

// "Auto Recharge" is the customer-facing name (matches OpenAI's API billing
// terminology) — kept as AutoPay* internally, this is purely a copy choice.
export interface AutoPaySettings {
  enabled: boolean;
  thresholdCredits: number;
  rechargeAmountCredits: number;
  paymentMethodId?: string;
  dailyCapCredits?: number;
  monthlyCapCredits?: number;
  lastTriggeredAt?: string;
  consecutiveFailures: number;
}

// Customer-safe subset of the admin-configured Auto Recharge policy — the
// minimum/maximum recharge amount is an ADMIN setting (see
// AdminPaymentSettingsPage.tsx), never something the customer edits here.
export interface AutoRechargePolicy {
  minCredits?: number;
  maxCredits?: number;
  defaultOn: boolean;
  currency: string;
}

export interface WalletSummary {
  balanceCredits: number;
  reservedCredits: number;
  availableCredits: number;
  lowBalanceThresholdCredits: number;
  lowBalance: boolean;
  autoPay: AutoPaySettings;
  autoRechargePolicy: AutoRechargePolicy;
}

// Phase 0 of the ChatGPT-style entitlements migration — the payload behind
// GET /billing/entitlements (EntitlementsService.canAccess/listForOrganization
// on the backend). Separate from WalletSummary; not wired into any
// enforcement path yet.
export interface EntitlementAccess {
  key: string;
  name: string;
  type: 'boolean' | 'numeric';
  allowed: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
}

export interface CreditPackage {
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

export type WalletTransactionType =
  | 'PURCHASE'
  | 'AI_USAGE'
  | 'AUTO_RECHARGE'
  | 'BONUS'
  | 'PROMOTION'
  | 'REFUND'
  | 'MANUAL_ADJUSTMENT';

// Deliberately narrower than the backend's internal ledger row — no
// provider/model/cost fields exist here at all, matching what
// billing.service.ts's listCustomerTransactions actually returns.
// inputTokens/outputTokens ARE shown (Haive Input/Output Tokens per the
// spec) — only provider/model identity and provider cost are withheld.
export interface CustomerTransaction {
  id: string;
  type: WalletTransactionType;
  amountCredits: number;
  balanceAfterCredits: number;
  createdAt: string;
  description: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface UsageSummary {
  availableCredits: number;
  creditsUsedTotal: number;
  totalPurchasedCredits: number;
  aiRequestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  usageTodayCredits: number;
  usageThisMonthCredits: number;
}

export type PaymentProviderKey = 'razorpay' | 'stripe' | 'cashfree';

export interface PaymentMethod {
  _id: string;
  provider: PaymentProviderKey;
  cardLast4: string;
  cardNetwork: string;
  isDefault: boolean;
  createdAt: string;
}

export interface InitiatePurchaseResult {
  paymentRecordId: string;
  orderId: string;
  checkoutParams: Record<string, unknown>;
  simulated: boolean;
  creditedImmediately: boolean;
  wallet?: WalletSummary;
}

export interface AutoPaySettingsUpdate {
  enabled: boolean;
  thresholdCredits?: number;
  rechargeAmountCredits?: number;
  paymentMethodId?: string;
  monthlyCapCredits?: number;
}

// --- Phase 2: Subscriptions (mirrors backend/src/billing/billing-subscriptions.service.ts) ---

export type BillingCycle = 'monthly' | 'yearly' | 'weekly' | 'quarterly' | 'one_time';

export interface PlanFeatureGrant {
  featureKey: string;
  enabled: boolean;
  valueOverride?: string;
  // Resolved server-side from the Feature catalog for display — the plan
  // itself only ever stores featureKey (see BillingPlanFeatureGrantDto);
  // absent if the catalog entry was since deleted.
  name?: string;
}

export interface PlanLimitGrant {
  limitKey: string;
  unlimited: boolean;
  value?: number;
}

export interface PlanPrice {
  id: string;
  currencyCode: string;
  billingCycle: BillingCycle;
  amount: number;
  creditsGranted: number;
}

// Deliberately narrower than the admin catalog shape — no internalDescription,
// matching what GET /billing/plans actually returns (see
// BillingSubscriptionsService.listPublicPlans's own comment).
export interface PublicPlan {
  id: string;
  key: string;
  name: string;
  description?: string;
  shortDescription?: string;
  icon?: string;
  image?: string;
  badgeText?: string;
  badgeColor?: string;
  planColor?: string;
  recommended: boolean;
  trialDays?: number;
  features: PlanFeatureGrant[];
  limits: PlanLimitGrant[];
  prices: PlanPrice[];
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';

export interface SubscriptionSummary {
  id: string;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: { id: string; key: string; name: string } | null;
  price: { id: string; currencyCode: string; billingCycle: BillingCycle; amount: number; creditsGranted: number } | null;
}

export interface SubscriptionCheckoutResult {
  paymentRecordId: string;
  orderId: string;
  checkoutParams: Record<string, unknown>;
  simulated: boolean;
  activatedImmediately: boolean;
  subscription?: SubscriptionSummary;
}

// --- Phase 4: Invoices ---

export interface BillingInvoiceItem {
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
}

export interface BillingInvoiceSummary {
  _id: string;
  invoiceNumber: string;
  type: 'purchase' | 'autopay' | 'subscription_checkout' | 'subscription_renewal';
  status: 'paid' | 'void';
  currencyCode: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  items: BillingInvoiceItem[];
  issuedAt: string;
}

// --- Phase 5: Billing theme + public pricing page config ---

export interface BillingTheme {
  tokens: Record<string, string>;
  darkTokens: Record<string, string>;
  logoUrl?: string;
  faviconUrl?: string;
}

export interface BillingFaqEntry {
  question: string;
  answer: string;
}

export interface BillingPageConfig {
  heroHeadline?: string;
  heroSubtext?: string;
  ctaButtonText: string;
  faqEntries: BillingFaqEntry[];
  displayedPlanIds: string[];
}

export const billingService = {
  async getWallet(): Promise<WalletSummary> {
    const { data } = await axiosClient.get<WalletSummary>('/billing/wallet');
    return data;
  },

  async listPackages(): Promise<CreditPackage[]> {
    const { data } = await axiosClient.get<CreditPackage[]>('/billing/packages');
    return data;
  },

  async getUsageSummary(): Promise<UsageSummary> {
    const { data } = await axiosClient.get<UsageSummary>('/billing/usage/summary');
    return data;
  },

  async listTransactions(limit?: number): Promise<CustomerTransaction[]> {
    const { data } = await axiosClient.get<CustomerTransaction[]>('/billing/transactions', { params: { limit } });
    return data;
  },

  async listPaymentMethods(): Promise<PaymentMethod[]> {
    const { data } = await axiosClient.get<PaymentMethod[]>('/billing/payment-methods');
    return data;
  },

  async savePaymentMethod(payload: {
    gatewayCustomerId: string;
    gatewayPaymentId?: string;
    signature?: string;
    gatewayOrderId?: string;
    makeDefault?: boolean;
  }): Promise<PaymentMethod> {
    const { data } = await axiosClient.post<PaymentMethod>('/billing/payment-methods', payload);
    return data;
  },

  async setDefaultPaymentMethod(id: string): Promise<PaymentMethod> {
    const { data } = await axiosClient.post<PaymentMethod>(`/billing/payment-methods/${id}/default`);
    return data;
  },

  async deletePaymentMethod(id: string): Promise<void> {
    await axiosClient.delete(`/billing/payment-methods/${id}`);
  },

  async purchasePackage(packageKey: string): Promise<InitiatePurchaseResult> {
    const { data } = await axiosClient.post<InitiatePurchaseResult>('/billing/credits/purchase', { packageKey });
    return data;
  },

  // Called right after a real (non-simulated) checkout's success handler
  // fires, closing the loop without a publicly reachable webhook URL — see
  // backend/src/billing/billing.service.ts's confirmPurchase.
  async confirmPurchase(payload: {
    paymentRecordId: string;
    gatewayPaymentId: string;
    signature?: string;
  }): Promise<{ confirmed: boolean; wallet: WalletSummary }> {
    const { data } = await axiosClient.post<{ confirmed: boolean; wallet: WalletSummary }>('/billing/credits/confirm-purchase', payload);
    return data;
  },

  async getAutoPay(): Promise<AutoPaySettings> {
    const { data } = await axiosClient.get<AutoPaySettings>('/billing/autopay');
    return data;
  },

  async updateAutoPay(payload: AutoPaySettingsUpdate): Promise<AutoPaySettings> {
    const { data } = await axiosClient.put<AutoPaySettings>('/billing/autopay', payload);
    return data;
  },

  // --- Phase 0 of the ChatGPT-style entitlements migration: a new
  // read-only "what can I access" surface, built alongside the wallet
  // above (not a replacement for it) ---

  async getEntitlements(): Promise<EntitlementAccess[]> {
    const { data } = await axiosClient.get<EntitlementAccess[]>('/billing/entitlements');
    return data;
  },

  // --- Phase 2: Subscriptions ---

  async listPlans(currency?: string): Promise<PublicPlan[]> {
    const { data } = await axiosClient.get<PublicPlan[]>('/billing/plans', { params: currency ? { currency } : undefined });
    return data;
  },

  async getSubscription(): Promise<SubscriptionSummary | null> {
    const { data } = await axiosClient.get<SubscriptionSummary | null>('/billing/subscription');
    return data;
  },

  async subscriptionCheckout(payload: { planId: string; priceId: string; couponCode?: string }): Promise<SubscriptionCheckoutResult> {
    const { data } = await axiosClient.post<SubscriptionCheckoutResult>('/billing/subscription/checkout', payload);
    return data;
  },

  async confirmSubscription(payload: {
    paymentRecordId: string;
    gatewayPaymentId: string;
    signature?: string;
  }): Promise<{ confirmed: boolean; subscription: SubscriptionSummary | null }> {
    const { data } = await axiosClient.post<{ confirmed: boolean; subscription: SubscriptionSummary | null }>(
      '/billing/subscription/confirm',
      payload,
    );
    return data;
  },

  async cancelSubscription(): Promise<SubscriptionSummary> {
    const { data } = await axiosClient.post<SubscriptionSummary>('/billing/subscription/cancel');
    return data;
  },

  // --- Phase 4: Invoices ---

  async listInvoices(limit?: number): Promise<BillingInvoiceSummary[]> {
    const { data } = await axiosClient.get<BillingInvoiceSummary[]>('/billing/invoices', { params: { limit } });
    return data;
  },

  // --- Phase 5: Billing theme + public pricing page config ---

  async getTheme(): Promise<BillingTheme> {
    const { data } = await axiosClient.get<BillingTheme>('/billing/theme');
    return data;
  },

  async getPageConfig(): Promise<BillingPageConfig> {
    const { data } = await axiosClient.get<BillingPageConfig>('/billing/page-config');
    return data;
  },
};
