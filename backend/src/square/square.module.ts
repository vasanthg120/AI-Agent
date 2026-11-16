import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
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
  ],
  controllers: [SquareController, SquareWebhookController],
  providers: [SquareService, SquarePaymentMatchingService, SquareReconciliationService],
  exports: [SquareService, SquarePaymentMatchingService],
})
export class SquareModule {}
