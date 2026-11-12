import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { AdminAccount, AdminAccountSchema } from '../auth/schemas/admin-account.schema';
import { PricingService } from '../billing/pricing.service';
import { BillingSettings, BillingSettingsSchema } from '../billing/schemas/billing-settings.schema';
import { WalletTransaction, WalletTransactionSchema } from '../billing/schemas/wallet-transaction.schema';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { IntegrationCredential, IntegrationCredentialSchema } from '../integrations/schemas/integration-credential.schema';
import { AnthropicFinanceAdapter } from './adapters/anthropic-finance-adapter.service';
import { GroqFinanceAdapter } from './adapters/groq-finance-adapter.service';
import { ProviderFinanceAdapterRegistry } from './adapters/provider-finance-adapter.registry';
import { ProviderAlertService } from './provider-alert.service';
import { ProviderFinanceController } from './provider-finance.controller';
import { ProviderFinanceService } from './provider-finance.service';
import { ProviderUsageCostSyncService } from './provider-usage-cost-sync.service';
import { ProviderPaymentGridFsService } from './provider-payment-gridfs.service';
import { ProviderAccount, ProviderAccountSchema } from './schemas/provider-account.schema';
import { ProviderAlertLog, ProviderAlertLogSchema } from './schemas/provider-alert-log.schema';
import { ProviderPayment, ProviderPaymentSchema } from './schemas/provider-payment.schema';

// Platform expenditure/balance/payment tracking for LLM providers — reads
// AiUsageModule's AiUsageHierarchyService for cost figures (never
// recomputes them), WalletTransaction read-only for the revenue side of
// getProfitability(), and IntegrationCredential read-only for "is this
// provider actually connected" (the `connected` field — see
// provider-finance.service.ts's own class comment on why that's kept
// separate from finance/sync state). Never writes to WalletTransaction,
// IntegrationCredential, or any billing collection.
//
// PricingService + BillingSettings are registered directly here (own
// providers/schema, NOT `imports: [BillingModule]`) deliberately: BillingModule
// only exports ReservationService today, and importing the whole module (or
// editing its exports) for one read-only currency-conversion helper is a
// bigger footprint than this feature needs — this constructs the exact same
// PricingService class billing itself uses, so the conversion formula is
// never re-derived, while leaving billing.module.ts completely untouched.
//
// ProviderAlertService additionally reads AdminAccount (platform admin
// emails — the default alert-recipient list) and MailService (global, no
// import needed — see mail.module.ts's own @Global()). EncryptionService is
// also @Global() (see encryption.module.ts). HttpModule is needed here
// specifically for AnthropicFinanceAdapter's real calls to Anthropic's
// Usage/Cost and Rate Limits Admin APIs.
@Module({
  imports: [
    AiUsageModule,
    HttpModule.register({ timeout: 15_000 }),
    MongooseModule.forFeature([
      { name: ProviderAccount.name, schema: ProviderAccountSchema },
      { name: ProviderPayment.name, schema: ProviderPaymentSchema },
      { name: ProviderAlertLog.name, schema: ProviderAlertLogSchema },
      { name: WalletTransaction.name, schema: WalletTransactionSchema },
      { name: AdminAccount.name, schema: AdminAccountSchema },
      { name: IntegrationCredential.name, schema: IntegrationCredentialSchema },
      { name: BillingSettings.name, schema: BillingSettingsSchema },
    ]),
  ],
  controllers: [ProviderFinanceController],
  providers: [
    ProviderFinanceService,
    ProviderPaymentGridFsService,
    GridFsService,
    ProviderAlertService,
    ProviderUsageCostSyncService,
    AnthropicFinanceAdapter,
    GroqFinanceAdapter,
    ProviderFinanceAdapterRegistry,
    PricingService,
  ],
})
export class ProviderFinanceModule {}
