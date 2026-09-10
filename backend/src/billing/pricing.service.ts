import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Decimal from 'decimal.js';
import { BillingSettings, BillingSettingsDocument } from './schemas/billing-settings.schema';

/**
 * The single place `customer_price = provider_cost / (1 - target_margin)`
 * exists in this codebase. Every service that turns a USD provider cost
 * into a Haive Credit charge (ReservationService's settle(), the admin
 * revenue/margin aggregation) calls through here — none of them re-derive
 * the formula themselves.
 *
 * 50% margin is NOT 50% markup: $10 cost / (1 - 0.5) = $20 price, $10
 * profit, 50% margin (profit/price). A naive "+50%" markup ($15 price)
 * would only be a 33% margin.
 *
 * Credit peg: 1 Haive Credit = 1 unit of config.billing.currency
 * (CREDIT_VALUE_INR, ₹1 by default — INR being this platform's billing
 * currency). Rounding policy: every intermediate step (provider_cost USD →
 * customer USD → customer currency) stays high-precision via decimal.js;
 * rounding happens only at the two currency/credit boundaries
 * (usdToCredits/creditsToUsd), to 2 decimal places (matching the currency's
 * own minor unit — paise), never truncated to a whole credit. A ₹6.40
 * charge stays ₹6.40 in the ledger, not rounded to 6 or 7.
 */
@Injectable()
export class PricingService {
  constructor(
    private config: ConfigService,
    @InjectModel(BillingSettings.name) private settingsModel: Model<BillingSettingsDocument>,
  ) {}

  private get creditValueInCurrency(): Decimal {
    return new Decimal(this.config.get<number>('billing.creditValueInCurrency') ?? 1);
  }

  /** Admin-configurable (BillingSettings.targetGrossMarginPct, a 0-100
   * percentage set from Admin billing settings) takes precedence over the
   * TARGET_GROSS_MARGIN env var — same "DB override, env fallback" pattern
   * already established for autoRechargeMinCredits/defaultPaymentProvider
   * elsewhere in this schema. Returns a 0-1 fraction (matching this
   * service's own internal convention) either way. Async because the
   * admin override lives in Mongo — every caller that doesn't pass an
   * explicit marginOverride now awaits this, but there is exactly one
   * production caller (ReservationService.settle) plus the admin revenue
   * aggregations, which never touch margin at all (creditsToUsd is a pure
   * currency conversion, no margin involved).
   */
  async getTargetGrossMargin(): Promise<Decimal> {
    const settings = await this.settingsModel.findOne({ singletonKey: 'default' }, { targetGrossMarginPct: 1 }).exec();
    const pct = settings?.targetGrossMarginPct;
    if (pct !== undefined && pct !== null) return new Decimal(pct).dividedBy(100);
    return new Decimal(this.config.get<number>('billing.targetGrossMargin') ?? 0.5);
  }

  /** provider_cost USD -> customer-facing USD, at the given (0-1 fraction)
   * override or the resolved default margin. marginOverride is a FRACTION
   * (0.5 = 50%), not a percentage — matches this method's pre-existing
   * contract exactly; callers holding a 0-100 percentage (e.g.
   * ProviderPricing.marginOverridePct) divide by 100 before calling. */
  async costToCustomerUsd(costUsd: number, marginOverride?: number): Promise<Decimal> {
    const margin = marginOverride !== undefined ? new Decimal(marginOverride) : await this.getTargetGrossMargin();
    const retained = new Decimal(1).minus(margin);
    if (retained.lte(0)) {
      throw new Error(`Invalid gross margin ${margin.toString()} — must be less than 1.`);
    }
    return new Decimal(costUsd).dividedBy(retained);
  }

  /** provider_cost USD -> Haive Credits to charge, at 2-decimal precision
   * (never rounded to a whole credit). */
  async providerCostToCustomerCredits(costUsd: number, marginOverride?: number): Promise<number> {
    const customerUsd = await this.costToCustomerUsd(costUsd, marginOverride);
    return this.usdToCredits(customerUsd);
  }

  /** USD -> Haive Credits, via the configured currency bridge and the ₹1 =
   * 1 Credit peg — 2-decimal precision, HALF_UP, the only rounding boundary
   * between a USD cost and a credit charge. */
  usdToCredits(usdAmount: number | Decimal): number {
    const usd = usdAmount instanceof Decimal ? usdAmount : new Decimal(usdAmount);
    const inCurrency = new Decimal(this.usdToCurrency(usd.toNumber()));
    return inCurrency.dividedBy(this.creditValueInCurrency).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  }

  /** Credits -> USD, via the same currency bridge in reverse — for
   * display/reporting and for computing an AutoPay/purchase charge amount,
   * never for re-deriving a settlement charge (that only ever flows
   * costUsd -> credits, never the other way). */
  creditsToUsd(credits: number): number {
    const inCurrency = new Decimal(credits).times(this.creditValueInCurrency).toNumber();
    return this.currencyToUsd(inCurrency);
  }

  /** config.billing.currency — whatever credit packages are actually priced
   * in (not necessarily USD; see billing-seed.service.ts). */
  get billingCurrency(): string {
    return this.config.get<string>('billing.currency') ?? 'INR';
  }

  /** rateOverride lets a caller price against a specific Currency catalog
   * row's usdToCurrencyRate (see schemas/currency.schema.ts) instead of the
   * platform-wide config.billing.usdToCurrencyRate — e.g. a future
   * multi-currency checkout quoting a price in whichever currency the
   * customer picked. No current call site passes this (ReservationService/
   * BillingAdminService/BillingService all still get the platform default),
   * so this is purely additive — behavior for every existing caller is
   * unchanged. */
  currencyToUsd(amount: number, rateOverride?: number): number {
    const rate = rateOverride ?? this.config.get<number>('billing.usdToCurrencyRate') ?? 83;
    return new Decimal(amount).dividedBy(rate).toNumber();
  }

  usdToCurrency(amountUsd: number, rateOverride?: number): number {
    const rate = rateOverride ?? this.config.get<number>('billing.usdToCurrencyRate') ?? 83;
    return new Decimal(amountUsd).times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  }
}
