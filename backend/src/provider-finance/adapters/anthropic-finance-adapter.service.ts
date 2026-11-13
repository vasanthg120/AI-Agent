import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import {
  CapabilityMatrix,
  ProviderCapability,
  ProviderFinanceAdapter,
  UsageCostPoint,
  UsageCostReport,
} from './provider-capability-adapter.interface';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
// Anthropic's docs (platform.claude.com/docs/en/manage-claude/usage-cost-api,
// as of this build) point new integrations at a newer "Usage and Cost
// Analytics API" but confirm the legacy Admin API endpoints below are still
// documented and valid today — built against these because their exact
// parameter shape (starting_at/ending_at/limit/page, response
// {data, has_more, next_page}) is directly confirmed in the docs, rather
// than guessed from the newer page's unconfirmed reference.
const COST_REPORT_PATH = '/v1/organizations/cost_report';
const RATE_LIMITS_PATH = '/v1/organizations/rate_limits';
const ANTHROPIC_VERSION = '2023-06-01';
const PAGE_LIMIT = 31; // Anthropic's documented max days per 1d-bucket page for these reports.

// CONFIRMED directly from the current official docs (platform.claude.com/
// docs/en/api/beta/organization/cost_report, fetched live — not inferred
// from an example's decimal precision): "Cost amount in lowest currency
// units (e.g. cents) as a decimal string. For example, "123.45" in "USD"
// represents $1.23." A previous version of this adapter treated `amount` as
// whole dollars, which silently under-reported real cost by 100x — fixed
// below (divide by 100). Keep this divisor tied to `currency` if a provider
// ever returns a non-2-decimal currency; today currency is "always USD" per
// the same docs, so a flat /100 is correct for every row.
const MINOR_UNITS_PER_WHOLE_UNIT = 100;

interface AnthropicReportPage {
  // Confirmed field shape directly from the docs' own example response:
  // `amount` (decimal string, minor units) and `currency` sit directly on
  // each results[] item, not nested under a `cost` object.
  data: Array<{ starting_at: string; results?: Array<{ amount?: string; currency?: string }> }>;
  has_more: boolean;
  next_page: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class AnthropicFinanceAdapter implements ProviderFinanceAdapter {
  readonly provider = 'anthropic';
  private readonly logger = new Logger(AnthropicFinanceAdapter.name);

  constructor(private http: HttpService) {}

  getCapabilities(account: { adminApiKeyEncrypted?: string }): CapabilityMatrix {
    const hasAdminKey = !!account.adminApiKeyEncrypted;
    const configRequired = { status: 'CONFIGURATION_REQUIRED' as const, detail: 'Add an Admin API key (console.anthropic.com -> Settings -> Admin keys) to enable this.' };
    const consoleOnly = { status: 'UNSUPPORTED' as const, detail: 'Anthropic exposes no API for this — Console-only (verified against official docs).' };

    return {
      [ProviderCapability.BALANCE_READ]: consoleOnly,
      [ProviderCapability.USAGE_COST_READ]: hasAdminKey
        ? { status: 'SUPPORTED', detail: 'Synced hourly from the Usage and Cost Admin API.' }
        : configRequired,
      [ProviderCapability.INVOICE_HISTORY_READ]: consoleOnly,
      [ProviderCapability.PAYMENT_HISTORY_READ]: { status: 'UNSUPPORTED', detail: 'No provider-side payment/transaction API — recorded payments below are Haive\'s own ledger.' },
      [ProviderCapability.AUTO_RECHARGE_READ]: consoleOnly,
      [ProviderCapability.AUTO_RECHARGE_CONFIGURE]: consoleOnly,
      [ProviderCapability.SPEND_LIMIT_READ]: { status: 'UNSUPPORTED', detail: 'Dollar spend limits are Console-only — the Rate Limits API covers throughput, not spend caps.' },
      [ProviderCapability.SPEND_LIMIT_CONFIGURE]: consoleOnly,
      [ProviderCapability.RATE_LIMIT_READ]: hasAdminKey
        ? { status: 'SUPPORTED', detail: 'Read live from the Rate Limits API.' }
        : configRequired,
      [ProviderCapability.EXHAUSTION_DETECTION]: { status: 'SUPPORTED', detail: 'A confirmed HTTP 402 billing_error from a real API call automatically marks this provider exhausted.' },
    };
  }

  private async getWithRetry<T>(path: string, params: Record<string, string>, adminApiKey: string): Promise<T> {
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const { data } = await firstValueFrom(
          this.http.get<T>(`${ANTHROPIC_API_BASE}${path}`, {
            params,
            headers: { 'x-api-key': adminApiKey, 'anthropic-version': ANTHROPIC_VERSION },
            timeout: 15_000,
          }),
        );
        return data;
      } catch (err) {
        lastErr = err;
        const status = (err as { response?: { status?: number } }).response?.status;
        const retryable = status === 429 || (status !== undefined && status >= 500);
        if (!retryable || attempt === maxAttempts) throw err;
        const backoffMs = 500 * 2 ** (attempt - 1);
        this.logger.warn(`Anthropic ${path} returned ${status} — retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`);
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  }

  /** Paginates the given report path fully, handling Anthropic's cursor
   * (`page`/`next_page`/`has_more`) — never returns a partial page as if it
   * were complete. */
  private async drainReport(path: string, since: Date, adminApiKey: string): Promise<AnthropicReportPage['data']> {
    const all: AnthropicReportPage['data'] = [];
    let page: string | undefined;
    let guard = 0;
    do {
      guard += 1;
      if (guard > 500) throw new Error(`${path}: exceeded pagination safety limit — possible infinite loop.`);
      const params: Record<string, string> = { starting_at: since.toISOString(), limit: String(PAGE_LIMIT) };
      if (page) params.page = page;
      const result = await this.getWithRetry<AnthropicReportPage>(path, params, adminApiKey);
      all.push(...result.data);
      page = result.has_more ? result.next_page ?? undefined : undefined;
    } while (page);
    return all;
  }

  async syncUsageCost(adminApiKey: string, since: Date): Promise<UsageCostReport> {
    const rows = await this.drainReport(COST_REPORT_PATH, since, adminApiKey);
    const byDate = new Map<string, number>();
    for (const bucket of rows) {
      const date = bucket.starting_at.slice(0, 10);
      const dayCostMinorUnits = (bucket.results ?? []).reduce((sum, r) => sum + (r.amount ? Number(r.amount) : 0), 0);
      const dayCost = dayCostMinorUnits / MINOR_UNITS_PER_WHOLE_UNIT;
      byDate.set(date, (byDate.get(date) ?? 0) + dayCost);
    }
    const points: UsageCostPoint[] = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, costUsd]) => ({ date, costUsd }));
    return { points, totalCostUsd: points.reduce((sum, p) => sum + p.costUsd, 0) };
  }

  async readRateLimits(adminApiKey: string): Promise<{ ok: boolean; status: 'SUPPORTED' | 'PERMISSION_REQUIRED' | 'UNSUPPORTED' | 'ERROR'; detail: string; data?: unknown }> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${ANTHROPIC_API_BASE}${RATE_LIMITS_PATH}`, {
          headers: { 'x-api-key': adminApiKey, 'anthropic-version': ANTHROPIC_VERSION },
          timeout: 10_000,
        }),
      );
      return { ok: true, status: 'SUPPORTED', detail: 'Read live.', data };
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) return { ok: false, status: 'PERMISSION_REQUIRED', detail: 'The configured Admin API key was rejected — check it is a valid, active Admin key.' };
      if (status === 404) return { ok: false, status: 'UNSUPPORTED', detail: 'Endpoint not found for this account.' };
      return { ok: false, status: 'ERROR', detail: `Rate limits check failed: ${(err as Error).message}` };
    }
  }
}
