import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingFeature, BillingFeatureDocument } from './schemas/billing-feature.schema';
import { BillingPlan, BillingPlanDocument } from './schemas/billing-plan.schema';
import { BillingPlanPrice, BillingPlanPriceDocument } from './schemas/billing-plan-price.schema';
import { BillingSubscription, BillingSubscriptionDocument } from './schemas/billing-subscription.schema';
import { CreateBillingFeatureDto } from './dto/create-billing-feature.dto';
import { CreateBillingPlanDto } from './dto/create-billing-plan.dto';
import { CreateBillingPlanPriceDto } from './dto/create-billing-plan-price.dto';
import { UpdateBillingFeatureDto } from './dto/update-billing-feature.dto';
import { UpdateBillingPlanDto } from './dto/update-billing-plan.dto';

/**
 * Phase 0 admin CRUD for the billing plan/price/feature catalog — purely
 * additive alongside the existing credits-wallet billing system; nothing
 * here is read by any customer-facing route yet (a future
 * `GET /billing/plans` is what will read it). Gated entirely by
 * billing-admin-plans.controller.ts's @Roles('platform_admin').
 */
@Injectable()
export class BillingAdminPlansService {
  constructor(
    @InjectModel(BillingPlan.name) private planModel: Model<BillingPlanDocument>,
    @InjectModel(BillingPlanPrice.name) private priceModel: Model<BillingPlanPriceDocument>,
    @InjectModel(BillingFeature.name) private featureModel: Model<BillingFeatureDocument>,
    @InjectModel(BillingSubscription.name) private subscriptionModel: Model<BillingSubscriptionDocument>,
  ) {}

  listPlans() {
    return this.planModel.find().sort({ sortOrder: 1 }).exec();
  }

  async getPlan(id: string): Promise<BillingPlanDocument> {
    const plan = await this.planModel.findById(id).exec();
    if (!plan) throw new NotFoundException('Plan not found.');
    return plan;
  }

  async createPlan(dto: CreateBillingPlanDto): Promise<BillingPlanDocument> {
    const existing = await this.planModel.findOne({ key: dto.key }).exec();
    if (existing) throw new BadRequestException(`A plan with key "${dto.key}" already exists.`);
    return this.planModel.create(dto);
  }

  async updatePlan(id: string, dto: UpdateBillingPlanDto): Promise<BillingPlanDocument> {
    const plan = await this.planModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!plan) throw new NotFoundException('Plan not found.');
    return plan;
  }

  /** Archives rather than deletes — a plan an org has already subscribed to
   * must keep resolving historically even once retired from the public
   * catalog, same reasoning as CreditPackage never being hard-deleted. */
  async archivePlan(id: string): Promise<BillingPlanDocument> {
    const plan = await this.planModel.findByIdAndUpdate(id, { $set: { active: false, isPublic: false } }, { new: true }).exec();
    if (!plan) throw new NotFoundException('Plan not found.');
    return plan;
  }

  async activatePlan(id: string): Promise<BillingPlanDocument> {
    const plan = await this.planModel.findByIdAndUpdate(id, { $set: { active: true } }, { new: true }).exec();
    if (!plan) throw new NotFoundException('Plan not found.');
    return plan;
  }

  /** A real, permanent delete — unlike archivePlan, only allowed when the
   * plan has never had a subscription (active or historical), so a org's
   * billing history can never end up pointing at a plan that no longer
   * exists. Blocked plans should use archivePlan instead. Cascades to the
   * plan's own price rows (BillingPlanPrice), which are meaningless once
   * their plan is gone and were never independently reachable anywhere
   * else in the admin UI. */
  async deletePlan(id: string): Promise<void> {
    await this.getPlan(id); // 404s if the plan doesn't exist
    const hasSubscriptionHistory = await this.subscriptionModel.exists({ planId: id });
    if (hasSubscriptionHistory) {
      throw new BadRequestException('This plan has subscription history and cannot be deleted — archive it instead.');
    }
    await this.priceModel.deleteMany({ planId: id });
    await this.planModel.deleteOne({ _id: id });
  }

  async duplicatePlan(id: string, newKey: string): Promise<BillingPlanDocument> {
    const source = await this.getPlan(id);
    const existing = await this.planModel.findOne({ key: newKey }).exec();
    if (existing) throw new BadRequestException(`A plan with key "${newKey}" already exists.`);
    const clone = source.toObject() as Record<string, unknown>;
    delete clone._id;
    delete clone.createdAt;
    delete clone.updatedAt;
    delete clone.__v;
    return this.planModel.create({ ...clone, key: newKey, name: `${source.name} (copy)`, isPublic: false });
  }

  async reorderPlans(orderedIds: string[]): Promise<void> {
    await Promise.all(orderedIds.map((id, index) => this.planModel.updateOne({ _id: id }, { $set: { sortOrder: index } })));
  }

  listPrices(planId: string) {
    return this.priceModel.find({ planId }).sort({ currencyCode: 1, billingCycle: 1, effectiveFrom: -1 }).exec();
  }

  /** Closes out any currently-active price for the same (plan, currency,
   * cycle) tuple before inserting the new one — see
   * schemas/billing-plan-price.schema.ts's effectiveFrom/effectiveTo
   * versioning comment for why this is additive, not a mutation. */
  async addPrice(planId: string, dto: CreateBillingPlanPriceDto): Promise<BillingPlanPriceDocument> {
    await this.getPlan(planId); // 404s if the plan doesn't exist
    const now = new Date();
    await this.priceModel.updateMany(
      { planId, currencyCode: dto.currencyCode, billingCycle: dto.billingCycle, effectiveTo: null },
      { $set: { effectiveTo: now, active: false } },
    );
    return this.priceModel.create({ ...dto, planId, effectiveFrom: now, effectiveTo: null, active: true });
  }

  async removePrice(priceId: string): Promise<void> {
    const result = await this.priceModel.updateOne(
      { _id: priceId, effectiveTo: null },
      { $set: { effectiveTo: new Date(), active: false } },
    );
    if (result.matchedCount === 0) throw new NotFoundException('Active price not found.');
  }

  listFeatures() {
    return this.featureModel.find().sort({ category: 1, name: 1 }).exec();
  }

  async createFeature(dto: CreateBillingFeatureDto): Promise<BillingFeatureDocument> {
    const existing = await this.featureModel.findOne({ key: dto.key }).exec();
    if (existing) throw new BadRequestException(`A feature with key "${dto.key}" already exists.`);
    return this.featureModel.create(dto);
  }

  async updateFeature(id: string, dto: UpdateBillingFeatureDto): Promise<BillingFeatureDocument> {
    const feature = await this.featureModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!feature) throw new NotFoundException('Feature not found.');
    return feature;
  }
}
