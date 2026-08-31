import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';

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
  constructor(private config: ConfigService) {}

  private get creditValueInCurrency(): Decimal {
    return new Decimal(this.config.get<number>('billing.creditValueInCurrency') ?? 1);
  }

  private get targetGrossMargin(): Decimal {
    return new Decimal(this.config.get<number>('billing.targetGrossMargin') ?? 0.5);
  }

  /** provider_cost USD -> customer-facing USD, at the given (or default) margin. */
  costToCustomerUsd(costUsd: number, marginOverride?: number): Decimal {
    const margin = marginOverride !== undefined ? new Decimal(marginOverride) : this.targetGrossMargin;
    const retained = new Decimal(1).minus(margin);
    if (retained.lte(0)) {
      throw new Error(`Invalid gross margin ${margin.toString()} — must be less than 1.`);
    }
    return new Decimal(costUsd).dividedBy(retained);
  }

  /** provider_cost USD -> Haive Credits to charge, at 2-decimal precision
   * (never rounded to a whole credit). */
  providerCostToCustomerCredits(costUsd: number, marginOverride?: number): number {
    const customerUsd = this.costToCustomerUsd(costUsd, marginOverride);
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
