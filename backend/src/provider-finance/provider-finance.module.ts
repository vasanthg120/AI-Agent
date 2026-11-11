import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { AdminAccount, AdminAccountSchema } from '../auth/schemas/admin-account.schema';
import { WalletTransaction, WalletTransactionSchema } from '../billing/schemas/wallet-transaction.schema';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { ProviderAlertService } from './provider-alert.service';
import { ProviderFinanceController } from './provider-finance.controller';
import { ProviderFinanceService } from './provider-finance.service';
import { ProviderPaymentGridFsService } from './provider-payment-gridfs.service';
import { ProviderAccount, ProviderAccountSchema } from './schemas/provider-account.schema';
import { ProviderPayment, ProviderPaymentSchema } from './schemas/provider-payment.schema';

// Platform expenditure/balance/payment tracking for LLM providers — reads
// AiUsageModule's AiUsageHierarchyService for cost figures (never
// recomputes them) and WalletTransaction read-only for the revenue side of
// getProfitability(). Never writes to WalletTransaction or any billing
// collection — see provider-finance.service.ts's own class comment.
// ProviderAlertService (Phase B) additionally reads AdminAccount (platform
// admin emails — the default alert-recipient list) and MailService (global,
// no import needed — see mail.module.ts's own @Global()).
@Module({
  imports: [
    AiUsageModule,
    MongooseModule.forFeature([
      { name: ProviderAccount.name, schema: ProviderAccountSchema },
      { name: ProviderPayment.name, schema: ProviderPaymentSchema },
      { name: WalletTransaction.name, schema: WalletTransactionSchema },
      { name: AdminAccount.name, schema: AdminAccountSchema },
    ]),
  ],
  controllers: [ProviderFinanceController],
  providers: [ProviderFinanceService, ProviderPaymentGridFsService, GridFsService, ProviderAlertService],
})
export class ProviderFinanceModule {}
