import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { PricingService } from './pricing.service';
import { BillingSettingsDocument } from './schemas/billing-settings.schema';

// Pure unit tests — no Mongo, no NestJS DI container. PricingService depends
// on ConfigService.get() (unchanged) plus, since the admin-configurable
// global margin override, a Mongoose model for BillingSettings — a plain
// fake satisfies both, no real database needed. `settingsOverride` lets a
// test simulate an admin having set BillingSettings.targetGrossMarginPct;
// omitting it (the default) means "no admin override" — findOne resolves to
// null, matching a fresh/never-configured deployment.
function makePricing(overrides: Record<string, unknown> = {}, settingsOverride: { targetGrossMarginPct?: number } | null = null): PricingService {
  const values: Record<string, unknown> = {
    'billing.creditValueInCurrency': 1,
    'billing.targetGrossMargin': 0.5,
    'billing.currency': 'INR',
    'billing.usdToCurrencyRate': 83,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  const settingsModel = {
    findOne: () => ({ exec: () => Promise.resolve(settingsOverride) }),
  } as unknown as Model<BillingSettingsDocument>;
  return new PricingService(config, settingsModel);
}

describe('PricingService — 50% gross margin (not markup)', () => {
  // Spec §49 MARGIN test cases, verbatim: provider cost -> customer charge,
  // at a 1:1 USD:currency rate so the margin math is visible directly.
  it('$1 provider cost -> $2 customer charge (50% margin)', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 });
    expect((await pricing.costToCustomerUsd(1)).toNumber()).toBeCloseTo(2, 10);
  });

  it('$2.50 provider cost -> $5 customer charge (50% margin)', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 });
    expect((await pricing.costToCustomerUsd(2.5)).toNumber()).toBeCloseTo(5, 10);
  });

  it('$7.50 provider cost -> $15 customer charge (50% margin)', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 });
    expect((await pricing.costToCustomerUsd(7.5)).toNumber()).toBeCloseTo(15, 10);
  });

  it('is division by (1 - margin), not a 1.5x markup', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 });
    const customer = (await pricing.costToCustomerUsd(10)).toNumber();
    expect(customer).toBeCloseTo(20, 10); // NOT 15 (a naive +50% markup)
    const grossMargin = (customer - 10) / customer;
    expect(grossMargin).toBeCloseTo(0.5, 10);
  });

  it('rejects a margin >= 1 (would imply infinite or negative price)', async () => {
    const pricing = makePricing();
    await expect(pricing.costToCustomerUsd(10, 1)).rejects.toThrow();
  });

  it('70% provider cost -> $1 / (1 - 0.7) = $3.333... customer charge', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 });
    expect((await pricing.costToCustomerUsd(1, 0.7)).toNumber()).toBeCloseTo(3.3333333333, 9);
  });
});

describe('PricingService — dynamic admin-configured global margin (BillingSettings.targetGrossMarginPct)', () => {
  it('with no admin override, falls back to config.billing.targetGrossMargin unchanged', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1, 'billing.targetGrossMargin': 0.5 }, null);
    expect((await pricing.costToCustomerUsd(1)).toNumber()).toBeCloseTo(2, 10); // $1 / (1-0.5)
  });

  it('an admin-set targetGrossMarginPct of 70 overrides the env default (50%) for future usage', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1, 'billing.targetGrossMargin': 0.5 }, { targetGrossMarginPct: 70 });
    expect((await pricing.costToCustomerUsd(1)).toNumber()).toBeCloseTo(3.3333333333, 9); // $1 / (1-0.7)
  });

  it('an explicit per-call marginOverride still wins over the admin-configured global value', async () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 }, { targetGrossMarginPct: 70 });
    // Explicit 0.5 fraction passed in — must NOT use the 70% admin override.
    expect((await pricing.costToCustomerUsd(1, 0.5)).toNumber()).toBeCloseTo(2, 10);
  });

  it('getTargetGrossMargin returns the resolved fraction directly', async () => {
    const pricing = makePricing({}, { targetGrossMarginPct: 60 });
    expect((await pricing.getTargetGrossMargin()).toNumber()).toBeCloseTo(0.6, 10);
  });
});

describe('PricingService — 1 Haive Credit = ₹1 INR, decimal precision', () => {
  it('₹1 = 1 credit under the default peg', () => {
    const pricing = makePricing();
    // $1 USD -> ₹83 (rate 83) -> 83 credits, at the default peg.
    expect(pricing.usdToCredits(1)).toBeCloseTo(83, 2);
  });

  it('never rounds to a whole credit — preserves 2-decimal precision', () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 });
    // 6.4 USD -> ₹6.40 (rate 1) -> 6.4 credits, not rounded to 6.
    expect(pricing.usdToCredits(6.4)).toBe(6.4);
    expect(pricing.usdToCredits(3.27)).toBe(3.27);
    expect(pricing.usdToCredits(0.85)).toBe(0.85);
  });

  it('providerCostToCustomerCredits composes margin + credit conversion, undiscretized', async () => {
    // Spec §41: provider cost ₹2.50 (i.e. $2.50 at a 1:1 rate) -> 50%
    // margin -> ₹5.00 customer charge -> 5 credits used.
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 1 });
    expect(await pricing.providerCostToCustomerCredits(2.5)).toBeCloseTo(5, 10);
    // Spec §42: ₹7.50 -> ₹15.00 -> 15 credits.
    expect(await pricing.providerCostToCustomerCredits(7.5)).toBeCloseTo(15, 10);
  });

  it('creditsToUsd is the true inverse of usdToCredits at the default peg', () => {
    const pricing = makePricing();
    const usd = 12.3456;
    const credits = pricing.usdToCredits(usd);
    const roundTrippedUsd = pricing.creditsToUsd(credits);
    expect(roundTrippedUsd).toBeCloseTo(usd, 2);
  });

  it('a non-default CREDIT_VALUE_INR changes the peg correctly', () => {
    const pricing = makePricing({ 'billing.creditValueInCurrency': 2, 'billing.usdToCurrencyRate': 1 });
    // ₹10 at 1 credit = ₹2 -> 5 credits.
    expect(pricing.usdToCredits(10)).toBe(5);
  });
});

// Phase 1 (Currency catalog, see schemas/currency.schema.ts) — the optional
// rateOverride param on usdToCurrency/currencyToUsd. Every existing call
// site omits it and keeps reading config.billing.usdToCurrencyRate exactly
// as before (covered by the two describe blocks above, unmodified); this
// only covers the new override behavior in isolation.
describe('PricingService — currencyToUsd/usdToCurrency rateOverride (Phase 1, Currency catalog)', () => {
  it('usdToCurrency uses the override rate instead of the configured platform rate', () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 83 }); // platform default (INR)
    // $1 at an overridden rate of 90 (e.g. a Currency row's own rate) -> 90, not 83.
    expect(pricing.usdToCurrency(1, 90)).toBe(90);
  });

  it('currencyToUsd uses the override rate instead of the configured platform rate', () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 83 });
    expect(pricing.currencyToUsd(90, 90)).toBeCloseTo(1, 10);
  });

  it('omitting rateOverride falls back to config.billing.usdToCurrencyRate unchanged', () => {
    const pricing = makePricing({ 'billing.usdToCurrencyRate': 83 });
    expect(pricing.usdToCurrency(1)).toBe(83);
    expect(pricing.currencyToUsd(83)).toBeCloseTo(1, 10);
  });

  it('usdToCurrency still rounds HALF_UP to 2 decimal places with an override rate', () => {
    const pricing = makePricing();
    // $1 at a 91.005 rate -> 91.005, rounded HALF_UP to 91.01 (2dp, paise-level precision).
    expect(pricing.usdToCurrency(1, 91.005)).toBe(91.01);
  });

  it('currencyToUsd/usdToCurrency with an override are true inverses, same as the default-rate pair', () => {
    const pricing = makePricing();
    const usd = 12.3456;
    const overrideRate = 90;
    const inCurrency = pricing.usdToCurrency(usd, overrideRate);
    const roundTrippedUsd = pricing.currencyToUsd(inCurrency, overrideRate);
    expect(roundTrippedUsd).toBeCloseTo(usd, 2);
  });
});
