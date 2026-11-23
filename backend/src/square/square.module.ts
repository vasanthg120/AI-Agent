import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SquarePaymentTransaction, SquarePaymentTransactionSchema } from './schemas/square-payment-transaction.schema';
import { SquareWebhookEvent, SquareWebhookEventSchema } from './schemas/square-webhook-event.schema';
import { SquareController } from './square.controller';
import { SquareService } from './square.service';
import { SquarePaymentMatchingService } from './square-payment-matching.service';
import { SquareReconciliationService } from './square-reconciliation.service';
import { SquareWebhookController } from './square-webhook.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SquarePaymentTransaction.name, schema: SquarePaymentTransactionSchema },
      { name: SquareWebhookEvent.name, schema: SquareWebhookEventSchema },
    ]),
    HttpModule.register({ timeout: 15_000 }),
    AuthModule,
    IntegrationsModule,
    // ChatGateway.emitToOrg — a Gateway Payment landing (webhook or
    // reconciliation) pushes a live event so an open Customers page can
    // refresh itself. Same reuse NotificationsModule already makes of
    // ChatGateway; chat.module.ts imports nothing from here, so no cycle.
    ChatModule,
  ],
  controllers: [SquareController, SquareWebhookController],
  providers: [SquareService, SquarePaymentMatchingService, SquareReconciliationService],
  // SquareReconciliationService: customer-intelligence (Customers page)
  // triggers it directly for a Square "Sync now" (customer-directory.
  // service.ts) — the same one-directional reuse shape XeroModule already
  // has in customer-intelligence.module.ts, never the other way around.
  exports: [SquareService, SquarePaymentMatchingService, SquareReconciliationService],
})
export class SquareModule {}
