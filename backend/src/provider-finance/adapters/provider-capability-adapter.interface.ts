// The "universal provider-capability-adapter" layer: one honest capability
// matrix per provider, backed by what each provider's REAL API can and
// can't do — verified live against official docs + the installed SDK
// source for Anthropic/Groq (the only two real, connected providers; see
// integrations.service.ts's PLATFORM_PROVIDERS), never assumed. A provider
// with no adapter implementation simply has no entry on the dashboard —
// same "absent, not stubbed" precedent FINANCE_TRACKED_PROVIDERS already
// set for OpenAI/Gemini (neither integrated anywhere in this app today).
export enum ProviderCapability {
  BALANCE_READ = 'BALANCE_READ',
  USAGE_COST_READ = 'USAGE_COST_READ',
  INVOICE_HISTORY_READ = 'INVOICE_HISTORY_READ',
  PAYMENT_HISTORY_READ = 'PAYMENT_HISTORY_READ',
  AUTO_RECHARGE_READ = 'AUTO_RECHARGE_READ',
  AUTO_RECHARGE_CONFIGURE = 'AUTO_RECHARGE_CONFIGURE',
  SPEND_LIMIT_READ = 'SPEND_LIMIT_READ',
  SPEND_LIMIT_CONFIGURE = 'SPEND_LIMIT_CONFIGURE',
  RATE_LIMIT_READ = 'RATE_LIMIT_READ',
  EXHAUSTION_DETECTION = 'EXHAUSTION_DETECTION',
}

export type CapabilityStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'PERMISSION_REQUIRED' | 'CONFIGURATION_REQUIRED' | 'ERROR';

export interface CapabilityEntry {
  status: CapabilityStatus;
  // Short, human-readable reason shown on the dashboard badge — e.g. "No
  // balance API exists for this provider (Console-only)" or "Add an Admin
  // API key to enable this". Always present, since a bare status code
  // without context is exactly the kind of thing that gets misread as
  // "broken" rather than "honestly not available".
  detail: string;
}

export type CapabilityMatrix = Record<ProviderCapability, CapabilityEntry>;

export interface UsageCostPoint {
  date: string; // YYYY-MM-DD
  costUsd: number;
}

export interface UsageCostReport {
  points: UsageCostPoint[];
  totalCostUsd: number;
}

export interface ProviderFinanceAdapter {
  readonly provider: string;

  /** Capability matrix for THIS account's current configuration (e.g.
   * USAGE_COST_READ flips from CONFIGURATION_REQUIRED to SUPPORTED once an
   * Admin API key is on file) — never a static, account-independent table. */
  getCapabilities(account: { adminApiKeyEncrypted?: string }): CapabilityMatrix;

  /** Only called when getCapabilities() reports USAGE_COST_READ as
   * SUPPORTED. Implementations handle their own pagination and
   * retry-with-backoff on 429/5xx — callers get back a fully-drained
   * report or a thrown error, never a partial page. */
  syncUsageCost?(adminApiKey: string, since: Date): Promise<UsageCostReport>;

  /** Only called when getCapabilities() reports RATE_LIMIT_READ as
   * SUPPORTED or PERMISSION_REQUIRED (a live call is how PERMISSION_REQUIRED
   * vs UNSUPPORTED is actually distinguished for this one capability — see
   * AnthropicFinanceAdapter). */
  readRateLimits?(adminApiKey: string): Promise<{ ok: boolean; status: CapabilityStatus; detail: string; data?: unknown }>;
}
