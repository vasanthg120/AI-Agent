import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { AgentExecution, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { CommandCenterModule } from '../command-center/command-center.module';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
// Independent local registration, not imported from UsersModule — same
// one-directional, avoid-a-cycle precedent UsersModule itself documents for
// AgentRole, and Royalty/Reporting use for Deal/Quote. Read-only here:
// BillingMigrationService only ever queries User, never writes to it.
import { User, UserSchema } from '../users/schemas/user.schema';
import { AutoPayService } from './autopay.service';
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminCouponsController } from './billing-admin-coupons.controller';
import { BillingAdminCouponsService } from './billing-admin-coupons.service';
import { BillingAdminCurrenciesController } from './billing-admin-currencies.controller';
import { BillingAdminCurrenciesService } from './billing-admin-currencies.service';
import { BillingAdminEntitlementsController } from './billing-admin-entitlements.controller';
import { BillingAdminEntitlementsService } from './billing-admin-entitlements.service';
import { BillingAdminGatewaysController } from './billing-admin-gateways.controller';
import { BillingAdminGatewaysService } from './billing-admin-gateways.service';
import { BillingAdminInvoicesController } from './billing-admin-invoices.controller';
import { BillingAdminInvoicesService } from './billing-admin-invoices.service';
import { BillingAdminMigrationController } from './billing-admin-migration.controller';
import { BillingAdminPackagesController } from './billing-admin-packages.controller';
import { BillingAdminPackagesService } from './billing-admin-packages.service';
import { BillingAdminPageConfigController } from './billing-admin-page-config.controller';
import { BillingAdminPlansController } from './billing-admin-plans.controller';
import { BillingAdminPlansService } from './billing-admin-plans.service';
import { BillingAdminRefundsController } from './billing-admin-refunds.controller';
import { BillingAdminService } from './billing-admin.service';
import { BillingAdminSettingsController } from './billing-admin-settings.controller';
import { BillingAdminSettingsService } from './billing-admin-settings.service';
import { BillingAdminSubscriptionsController } from './billing-admin-subscriptions.controller';
import { BillingAdminTaxesController } from './billing-admin-taxes.controller';
import { BillingAdminTaxesService } from './billing-admin-taxes.service';
import { BillingAdminTemplatesController } from './billing-admin-templates.controller';
import { BillingAdminTemplatesService } from './billing-admin-templates.service';
import { BillingAdminThemeController } from './billing-admin-theme.controller';
import { BillingInvoicePdfService } from './billing-invoice-pdf.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingMigrationService } from './billing-migration.service';
import { BillingPageConfigService } from './billing-page-config.service';
import { BillingSeedService } from './billing-seed.service';
import { BillingSubscriptionsService } from './billing-subscriptions.service';
import { BillingThemeService } from './billing-theme.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { CouponsService } from './coupons.service';
import { EntitlementsService } from './entitlements.service';
import { EntitlementsUsageAggregationService } from './entitlements-usage-aggregation.service';
import { RefundService } from './refund.service';
import { CashfreePaymentProvider } from './providers/cashfree-payment.provider';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { paymentProviderFactory } from './providers/payment-provider.factory';
import { RazorpayPaymentProvider } from './providers/razorpay-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';
import { PricingService } from './pricing.service';
import { ReservationService } from './reservation.service';
import { SubscriptionRenewalService } from './subscription-renewal.service';
import { WalletService } from './wallet.service';
import { BillingFeature, BillingFeatureSchema } from './schemas/billing-feature.schema';
import { BillingGatewayConfig, BillingGatewayConfigSchema } from './schemas/billing-gateway-config.schema';
import { BillingInvoiceCounter, BillingInvoiceCounterSchema } from './schemas/billing-invoice-counter.schema';
import { BillingInvoice, BillingInvoiceSchema } from './schemas/billing-invoice.schema';
import { BillingPageConfig, BillingPageConfigSchema } from './schemas/billing-page-config.schema';
import { BillingPlan, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingPlanPrice, BillingPlanPriceSchema } from './schemas/billing-plan-price.schema';
import { BillingSettings, BillingSettingsSchema } from './schemas/billing-settings.schema';
import { BillingTheme, BillingThemeSchema } from './schemas/billing-theme.schema';
import { BillingSubscriptionEvent, BillingSubscriptionEventSchema } from './schemas/billing-subscription-event.schema';
import { BillingSubscription, BillingSubscriptionSchema } from './schemas/billing-subscription.schema';
import { CouponRedemption, CouponRedemptionSchema } from './schemas/coupon-redemption.schema';
import { Coupon, CouponSchema } from './schemas/coupon.schema';
import { CreditPackage, CreditPackageSchema } from './schemas/credit-package.schema';
import { Currency, CurrencySchema } from './schemas/currency.schema';
import { InvoiceTemplate, InvoiceTemplateSchema } from './schemas/invoice-template.schema';
import { TaxRate, TaxRateSchema } from './schemas/tax-rate.schema';
import { CreditReservation, CreditReservationSchema } from './schemas/credit-reservation.schema';
import { PaymentMethod, PaymentMethodSchema } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordSchema } from './schemas/payment-record.schema';
import { ProviderPricing, ProviderPricingSchema } from './schemas/provider-pricing.schema';
import { Refund, RefundSchema } from './schemas/refund.schema';
import { Entitlement, EntitlementSchema } from './schemas/entitlement.schema';
import { UsageRecord, UsageRecordSchema } from './schemas/usage-record.schema';
import { UsageAggregationCursor, UsageAggregationCursorSchema } from './schemas/usage-aggregation-cursor.schema';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionSchema } from './schemas/wallet-transaction.schema';
import { WebhookEvent, WebhookEventSchema } from './schemas/webhook-event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wallet.name, schema: WalletSchema },
      { name: WalletTransaction.name, schema: WalletTransactionSchema },
      { name: CreditReservation.name, schema: CreditReservationSchema },
      { name: CreditPackage.name, schema: CreditPackageSchema },
      { name: ProviderPricing.name, schema: ProviderPricingSchema },
      { name: PaymentMethod.name, schema: PaymentMethodSchema },
      { name: PaymentRecord.name, schema: PaymentRecordSchema },
      { name: WebhookEvent.name, schema: WebhookEventSchema },
      { name: BillingPlan.name, schema: BillingPlanSchema },
      { name: BillingPlanPrice.name, schema: BillingPlanPriceSchema },
      { name: BillingFeature.name, schema: BillingFeatureSchema },
      { name: BillingSubscription.name, schema: BillingSubscriptionSchema },
      { name: BillingSubscriptionEvent.name, schema: BillingSubscriptionEventSchema },
      { name: Currency.name, schema: CurrencySchema },
      { name: TaxRate.name, schema: TaxRateSchema },
      { name: Coupon.name, schema: CouponSchema },
      { name: CouponRedemption.name, schema: CouponRedemptionSchema },
      { name: BillingInvoice.name, schema: BillingInvoiceSchema },
      { name: BillingInvoiceCounter.name, schema: BillingInvoiceCounterSchema },
      { name: BillingSettings.name, schema: BillingSettingsSchema },
      { name: InvoiceTemplate.name, schema: InvoiceTemplateSchema },
      { name: BillingTheme.name, schema: BillingThemeSchema },
      { name: BillingPageConfig.name, schema: BillingPageConfigSchema },
      { name: Refund.name, schema: RefundSchema },
      { name: BillingGatewayConfig.name, schema: BillingGatewayConfigSchema },
      { name: Entitlement.name, schema: EntitlementSchema },
      { name: UsageRecord.name, schema: UsageRecordSchema },
      { name: UsageAggregationCursor.name, schema: UsageAggregationCursorSchema },
      // Registered here too (already registered in CommandCenterModule) —
      // Mongoose doesn't mind the same schema/collection being bound to a
      // model in more than one module; ReservationService/BillingAdminService
      // need their own injectable Model<AgentExecutionDocument>.
      { name: AgentExecution.name, schema: AgentExecutionSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: User.name, schema: UserSchema },
    ]),
    CommandCenterModule,
  ],
  controllers: [
    BillingController,
    BillingAdminController,
    BillingAdminPlansController,
    BillingAdminMigrationController,
    BillingAdminCurrenciesController,
    BillingAdminTaxesController,
    BillingAdminCouponsController,
    BillingAdminInvoicesController,
    BillingAdminTemplatesController,
    BillingAdminSettingsController,
    BillingAdminThemeController,
    BillingAdminPageConfigController,
    BillingAdminRefundsController,
    BillingAdminGatewaysController,
    BillingAdminSubscriptionsController,
    BillingAdminPackagesController,
    BillingAdminEntitlementsController,
    BillingWebhookController,
  ],
  providers: [
    PricingService,
    WalletService,
    ReservationService,
    AutoPayService,
    BillingService,
    BillingAdminService,
    BillingAdminPlansService,
    BillingAdminPackagesService,
    EntitlementsService,
    EntitlementsUsageAggregationService,
    BillingAdminEntitlementsService,
    RefundService,
    BillingAdminGatewaysService,
    BillingMigrationService,
    BillingAdminCurrenciesService,
    BillingAdminTaxesService,
    BillingAdminCouponsService,
    CouponsService,
    BillingInvoiceService,
    BillingInvoicePdfService,
    BillingAdminInvoicesService,
    BillingAdminTemplatesService,
    BillingAdminSettingsService,
    BillingThemeService,
    BillingPageConfigService,
    BillingSubscriptionsService,
    SubscriptionRenewalService,
    BillingSeedService,
    RazorpayPaymentProvider,
    StripePaymentProvider,
    CashfreePaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: paymentProviderFactory,
      inject: [ConfigService, RazorpayPaymentProvider, StripePaymentProvider, CashfreePaymentProvider, getModelToken(BillingSettings.name)],
    },
  ],
  // ReservationService is the reserve/settle/release primitive chat's
  // billing gate is built on — exported so other AI-backed modules (see
  // business-knowledge-chat.service.ts) can adopt the exact same metering
  // contract instead of reinventing it. Nothing else in this module is
  // exported; every other provider/schema stays private to billing.
  exports: [ReservationService],
})
export class BillingModule {}
