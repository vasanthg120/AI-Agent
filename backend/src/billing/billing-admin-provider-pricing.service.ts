import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateProviderPricingDto } from './dto/create-provider-pricing.dto';
import { ProviderPricing, ProviderPricingDocument } from './schemas/provider-pricing.schema';

/**
 * Admin CRUD over the ProviderPricing registry — the piece section 9/15B of
 * the billing spec needed and didn't exist before: until now this
 * collection was only ever written by billing-seed.service.ts's one-time
 * day-0 seed and read by ReservationService.settle(). No admin surface
 * existed to change a rate or set a per-model margin override.
 *
 * "Update" is always a NEW row, never an edit-in-place — see the schema's
 * own effectiveFrom/effectiveTo comment. This is the one invariant that
 * keeps a future price/margin change from ever silently rewriting how an
 * already-settled transaction was priced (ReservationService.resolvePricing
 * always resolves by occurredAt against effectiveFrom/effectiveTo).
 */
@Injectable()
export class BillingAdminProviderPricingService {
  constructor(@InjectModel(ProviderPricing.name) private pricingModel: Model<ProviderPricingDocument>) {}

  /** Every row, both active and historical, newest first — the frontend
   * groups by (provider, model) and shows the currently-active one plus a
   * collapsible history, so nothing here needs to pre-filter. */
  list(): Promise<ProviderPricingDocument[]> {
    return this.pricingModel.find().sort({ provider: 1, model: 1, effectiveFrom: -1 }).exec();
  }

  async create(dto: CreateProviderPricingDto): Promise<ProviderPricingDocument> {
    const model = dto.model?.trim() || '*';
    const now = new Date();

    // Close out whatever row is currently active for this exact
    // (provider, model) — never delete/mutate it, only stamp its end-date,
    // so ReservationService.settle() resolving a PAST occurredAt still finds
    // it and prices historical usage exactly as it always did.
    await this.pricingModel
      .updateMany({ provider: dto.provider, model, effectiveTo: null }, { $set: { effectiveTo: now } })
      .exec();

    return this.pricingModel.create({
      provider: dto.provider,
      model,
      inputCostPerMTokUsd: dto.inputCostPerMTokUsd,
      outputCostPerMTokUsd: dto.outputCostPerMTokUsd,
      marginOverridePct: dto.marginOverridePct,
      effectiveFrom: now,
      effectiveTo: null,
    });
  }
}
