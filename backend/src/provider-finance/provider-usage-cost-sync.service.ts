import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { FINANCE_TRACKED_PROVIDERS, ProviderFinanceService } from './provider-finance.service';

// Automatic, scheduled usage-cost synchronization — the one real
// "balance/finance sync" this app can honestly run today, since no real
// provider exposes a balance-read API (see provider-account.schema.ts).
// Retry-with-backoff and pagination both live inside the adapter itself
// (AnthropicFinanceAdapter.syncUsageCost); this cron just drives it hourly
// and leaves the per-account success/error state visible on the dashboard —
// ProviderFinanceService.syncUsageCostForProvider() is a no-op for any
// provider/account where the capability isn't SUPPORTED, so running this
// unconditionally for every tracked provider never risks a fabricated call.
@Injectable()
export class ProviderUsageCostSyncService {
  private readonly logger = new Logger(ProviderUsageCostSyncService.name);

  constructor(private finance: ProviderFinanceService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async syncAll(): Promise<void> {
    for (const provider of FINANCE_TRACKED_PROVIDERS) {
      try {
        await this.finance.syncUsageCostForProvider(provider);
      } catch (err) {
        this.logger.error(`Usage-cost sync failed for ${provider}: ${(err as Error).message}`);
      }
    }
  }
}
