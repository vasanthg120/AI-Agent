import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ProviderPricing, ProviderPricingDocument } from './schemas/provider-pricing.schema';

// Mirrors python-agent/app/observability/cost.py's _RATES_PER_MTOK exactly
// — that file's own estimate stays in place unchanged as the settlement
// fallback for any (provider, model) with no active row here.
const DEFAULT_PROVIDER_PRICING = [
  { provider: 'anthropic', model: '*', inputCostPerMTokUsd: 3.0, outputCostPerMTokUsd: 15.0 },
  { provider: 'groq', model: '*', inputCostPerMTokUsd: 0.59, outputCostPerMTokUsd: 0.79 },
];

@Injectable()
export class BillingSeedService implements OnModuleInit {
  private readonly logger = new Logger(BillingSeedService.name);

  constructor(@InjectModel(ProviderPricing.name) private pricingModel: Model<ProviderPricingDocument>) {}

  async onModuleInit(): Promise<void> {
    // Credit packages are admin-created only (see
    // billing-admin-packages.controller.ts / Admin-haive's "Credit
    // Packages" page) — this used to seed 5 hardcoded examples on every
    // boot; that seeding was removed so "Add Credits" only ever shows what
    // an admin actually configured, never a static placeholder.
    for (const rateRow of DEFAULT_PROVIDER_PRICING) {
      const existing = await this.pricingModel.findOne({ provider: rateRow.provider, model: rateRow.model, effectiveTo: null });
      if (!existing) {
        await this.pricingModel.create({ ...rateRow, effectiveFrom: new Date(), effectiveTo: null });
      }
    }

    this.logger.log('Billing defaults verified (credit packages + provider pricing).');
  }
}
