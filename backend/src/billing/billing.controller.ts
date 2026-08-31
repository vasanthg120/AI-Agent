import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AutoPayService } from './autopay.service';
import { BillingInvoicePdfService } from './billing-invoice-pdf.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingPageConfigService } from './billing-page-config.service';
import { BillingService } from './billing.service';
import { BillingSubscriptionsService } from './billing-subscriptions.service';
import { BillingThemeService } from './billing-theme.service';
import { EntitlementsService } from './entitlements.service';
import { ReservationService } from './reservation.service';
import { AutoPaySettingsDto } from './dto/autopay-settings.dto';
import { ConfirmPurchaseDto } from './dto/confirm-purchase.dto';
import { ConfirmSubscriptionDto } from './dto/confirm-subscription.dto';
import { PurchasePackageDto } from './dto/purchase-package.dto';
import { RequestIdDto } from './dto/request-id.dto';
import { ReserveCreditsDto } from './dto/reserve-credits.dto';
import { SavePaymentMethodDto } from './dto/save-payment-method.dto';
import { SubscriptionCheckoutDto } from './dto/subscription-checkout.dto';

// Every route here is JwtAuthGuard-only (no @Roles) — reserve/settle/release
// are called by python-agent's service-role bridge token (see
// integration_executor.py's identical pattern for /integrations/execute),
// and the rest are ordinary customer-facing routes any authenticated user
// can use. Nothing here ever returns a provider name/model/cost — see
// billing.service.ts's listCustomerTransactions for the enforcement point.
//
// Billing is scoped per USER (user.sub) by default, not per organization —
// every call below deliberately passes tenantKey(user) as the tenant key into
// WalletService/ReservationService/AutoPayService/BillingService, none of
// which care whether that string is actually an org id or a user id; they
// just use it as an opaque wallet key. Each individual user therefore gets
// their own wallet, their own one-time free-trial grant, and their own Auto
// Recharge/saved payment method, matching a ChatGPT-style per-account model
// rather than a shared company pool.
//
// Phase 0 of the org-scoped billing extension (see billing-migration.service.ts)
// adds tenantKey() below as the ONE place this choice is made — with
// config.billing.orgScopingEnabled (env BILLING_ORG_SCOPED_WALLETS) left at
// its default `false`, tenantKey() still returns user.sub and every route
// below behaves exactly as before. Flipping it to `true` (only after running
// the migration in this environment) switches every route to the real
// user.organizationId instead, without any other logic in this file, in
// WalletService, or in ReservationService changing. The "actor" identity
// (who performed the action, e.g. WalletTransaction.createdBy /
// CreditReservation.userId) always stays user.sub regardless of this flag.
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(
    private billingService: BillingService,
    private reservationService: ReservationService,
    private autoPayService: AutoPayService,
    private subscriptionsService: BillingSubscriptionsService,
    private invoiceService: BillingInvoiceService,
    private invoicePdfService: BillingInvoicePdfService,
    private themeService: BillingThemeService,
    private pageConfigService: BillingPageConfigService,
    private entitlementsService: EntitlementsService,
    private config: ConfigService,
  ) {}

  private tenantKey(user: JwtPayload): string {
    return this.config.get<boolean>('billing.orgScopingEnabled') ? user.organizationId : user.sub;
  }

  @Get('wallet')
  getWallet(@CurrentUser() user: JwtPayload) {
    return this.billingService.getWalletSummary(this.tenantKey(user));
  }

  @Get('packages')
  listPackages() {
    return this.billingService.listPackages();
  }

  @Get('usage/summary')
  getUsageSummary(@CurrentUser() user: JwtPayload) {
    return this.billingService.getUsageSummary(this.tenantKey(user));
  }

  @Get('transactions')
  listTransactions(@CurrentUser() user: JwtPayload, @Query('limit') limit?: string) {
    return this.billingService.listCustomerTransactions(this.tenantKey(user), limit ? Number.parseInt(limit, 10) : undefined);
  }

  @Get('payment-methods')
  listPaymentMethods(@CurrentUser() user: JwtPayload) {
    return this.billingService.listPaymentMethods(this.tenantKey(user));
  }

  @Post('payment-methods')
  savePaymentMethod(@CurrentUser() user: JwtPayload, @Body() dto: SavePaymentMethodDto) {
    return this.billingService.savePaymentMethod(
      this.tenantKey(user),
      dto.gatewayCustomerId,
      dto.gatewayPaymentId ?? '',
      dto.signature ?? '',
      dto.gatewayOrderId ?? '',
      dto.makeDefault ?? false,
    );
  }

  @Post('payment-methods/:id/default')
  setDefaultPaymentMethod(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.billingService.setDefaultPaymentMethod(this.tenantKey(user), id);
  }

  @Delete('payment-methods/:id')
  deletePaymentMethod(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.billingService.deletePaymentMethod(this.tenantKey(user), id);
  }

  @Post('credits/purchase')
  purchase(@CurrentUser() user: JwtPayload, @Body() dto: PurchasePackageDto) {
    return this.billingService.initiatePurchase(this.tenantKey(user), user.sub, dto.packageKey, dto.couponCode);
  }

  // Called right after a real (non-simulated) checkout's client-side
  // success handler fires — closes the loop without needing a publicly
  // reachable webhook URL. See billing.service.ts's confirmPurchase for
  // why this can't be spoofed into granting free credits.
  @Post('credits/confirm-purchase')
  confirmPurchase(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmPurchaseDto) {
    return this.billingService.confirmPurchase(this.tenantKey(user), user.sub, dto.paymentRecordId, dto.gatewayPaymentId, dto.signature ?? '');
  }

  @Get('autopay')
  getAutoPay(@CurrentUser() user: JwtPayload) {
    return this.billingService.getWalletSummary(this.tenantKey(user)).then((w) => w.autoPay);
  }

  @Put('autopay')
  async updateAutoPay(@CurrentUser() user: JwtPayload, @Body() dto: AutoPaySettingsDto) {
    const wallet = await this.autoPayService.updateSettings(this.tenantKey(user), dto);
    return wallet.autoPay;
  }

  // --- Phase 0 of the ChatGPT-style entitlements migration (see
  // entitlements.service.ts) — a new read-only "what can I access" surface
  // built alongside the wallet above, not wired into reserve/settle/release
  // or any enforcement path yet. ---

  @Get('entitlements')
  listEntitlements(@CurrentUser() user: JwtPayload) {
    return this.entitlementsService.listForOrganization(this.tenantKey(user));
  }

  // --- Phase 2: Subscriptions (layer on top of the same wallet above — a
  // subscription grants credits into the exact same wallet tenantKey(user)
  // already resolves to, so it's spendable via the existing chat reserve/
  // settle flow with no additional wiring). ---

  @Get('plans')
  listPlans(@Query('currency') currency?: string) {
    return this.subscriptionsService.listPublicPlans(currency);
  }

  @Get('subscription')
  getSubscription(@CurrentUser() user: JwtPayload) {
    return this.subscriptionsService.getCurrentSubscription(this.tenantKey(user));
  }

  @Post('subscription/checkout')
  subscriptionCheckout(@CurrentUser() user: JwtPayload, @Body() dto: SubscriptionCheckoutDto) {
    return this.subscriptionsService.checkout(this.tenantKey(user), user.sub, dto);
  }

  // Same non-webhook confirmation path as credits/confirm-purchase above —
  // see BillingSubscriptionsService.confirm's comment for the identical
  // race-safety reasoning.
  @Post('subscription/confirm')
  confirmSubscription(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmSubscriptionDto) {
    return this.subscriptionsService.confirm(this.tenantKey(user), user.sub, dto);
  }

  @Post('subscription/cancel')
  cancelSubscription(@CurrentUser() user: JwtPayload) {
    return this.subscriptionsService.cancel(this.tenantKey(user));
  }

  // --- Phase 4: Invoices — one BillingInvoice per captured payment, see
  // BillingInvoiceService.generateForPaymentRecord's callers. ---

  @Get('invoices')
  listInvoices(@CurrentUser() user: JwtPayload, @Query('limit') limit?: string) {
    return this.invoiceService.listForOrganization(this.tenantKey(user), limit ? Number.parseInt(limit, 10) : undefined);
  }

  @Get('invoices/:id/pdf')
  async downloadInvoicePdf(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const invoice = await this.invoiceService.getForOrganization(this.tenantKey(user), id);
    const template = await this.invoiceService.getDefaultTemplate();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.pdf"`,
    });
    const doc = new PDFDocument();
    doc.pipe(res);
    this.invoicePdfService.writePdf(doc, invoice, template);
    doc.end();
  }

  @Get('invoices/:id/csv')
  async downloadInvoiceCsv(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const invoice = await this.invoiceService.getForOrganization(this.tenantKey(user), id);
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.csv"`,
    });
    res.send(this.invoiceService.toCsv(invoice));
  }

  // --- Phase 5: Billing theme + public pricing page config — both
  // singletons, read-only here (admin writes via billing-admin-theme.controller.ts
  // / billing-admin-page-config.controller.ts). ---

  @Get('theme')
  getTheme() {
    return this.themeService.getTheme();
  }

  @Get('page-config')
  getPageConfig() {
    return this.pageConfigService.getPageConfig();
  }

  // --- Service-to-service (python-agent's billing bridge) ---

  @Post('credits/reserve')
  reserve(@CurrentUser() user: JwtPayload, @Body() dto: ReserveCreditsDto) {
    return this.reservationService.reserve(this.tenantKey(user), user.sub, dto.requestId, dto.conversationId);
  }

  @Post('credits/settle')
  settle(@Body() dto: RequestIdDto) {
    return this.reservationService.settle(dto.requestId);
  }

  @Post('credits/release')
  release(@Body() dto: RequestIdDto) {
    return this.reservationService.release(dto.requestId);
  }
}
