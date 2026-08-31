import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingPlan, BillingPlanDocument } from './schemas/billing-plan.schema';
import { BillingSubscription, BillingSubscriptionDocument } from './schemas/billing-subscription.schema';
import { Entitlement, EntitlementDocument, EntitlementType } from './schemas/entitlement.schema';
import { UsageRecord, UsageRecordDocument } from './schemas/usage-record.schema';

export interface EntitlementAccessResult {
  key: string;
  name: string;
  type: EntitlementType;
  allowed: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
}

/**
 * Phase 0 of the ChatGPT-style billing migration — the literal "can this
 * user access feature X" read API the spec asks for (see the plan's own
 * §11), so the app can ask about a capability by entitlement key instead of
 * checking a plan name. Built ALONGSIDE the existing credits wallet, not
 * wired into reserve/settle/release or any enforcement path yet — this is a
 * new read surface only (see billing.controller.ts's GET /billing/entitlements).
 *
 * Numeric entitlements compare against UsageRecord rollups produced by
 * EntitlementsUsageAggregationService, which today only ever aggregates
 * into the single feature key 'ai_usage' (see usage-record.schema.ts's own
 * scoping note) — a numeric entitlement whose catalog key is anything else
 * always resolves with used:0/limit as configured, since no usage data
 * exists yet for it.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @InjectModel(Entitlement.name) private entitlementModel: Model<EntitlementDocument>,
    @InjectModel(BillingPlan.name) private planModel: Model<BillingPlanDocument>,
    @InjectModel(BillingSubscription.name) private subscriptionModel: Model<BillingSubscriptionDocument>,
    @InjectModel(UsageRecord.name) private usageModel: Model<UsageRecordDocument>,
  ) {}

  async canAccess(organizationId: string, entitlementKey: string): Promise<EntitlementAccessResult> {
    const entitlement = await this.entitlementModel.findOne({ key: entitlementKey, active: true }).exec();
    if (!entitlement) return { key: entitlementKey, name: entitlementKey, type: 'boolean', allowed: false };

    const subscription = await this.subscriptionModel
      .findOne({ organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
      .exec();
    if (!subscription) return this.denied(entitlement);

    const plan = await this.planModel.findById(subscription.planId).exec();
    const grant = plan?.entitlements.find((g) => g.key === entitlementKey);
    if (!grant) return this.denied(entitlement);

    if (entitlement.type === 'boolean') {
      return { key: entitlement.key, name: entitlement.name, type: 'boolean', allowed: grant.enabled };
    }

    if (grant.value === undefined) {
      // Numeric, no cap configured — unlimited.
      return { key: entitlement.key, name: entitlement.name, type: 'numeric', allowed: grant.enabled };
    }

    const [usage] = await this.usageModel
      .aggregate<{ total: number }>([
        {
          $match: {
            organizationId,
            feature: entitlement.key,
            periodStart: { $gte: subscription.currentPeriodStart },
            periodEnd: { $lte: subscription.currentPeriodEnd },
          },
        },
        { $group: { _id: null, total: { $sum: '$totalUnits' } } },
      ])
      .exec();
    const used = usage?.total ?? 0;
    const remaining = Math.max(grant.value - used, 0);
    return {
      key: entitlement.key,
      name: entitlement.name,
      type: 'numeric',
      allowed: grant.enabled && used < grant.value,
      limit: grant.value,
      used,
      remaining,
    };
  }

  /** Every active catalog entitlement's access status for the org — the
   * payload behind GET /billing/entitlements. */
  async listForOrganization(organizationId: string): Promise<EntitlementAccessResult[]> {
    const entitlements = await this.entitlementModel.find({ active: true }).sort({ createdAt: 1 }).exec();
    return Promise.all(entitlements.map((e) => this.canAccess(organizationId, e.key)));
  }

  private denied(entitlement: EntitlementDocument): EntitlementAccessResult {
    return { key: entitlement.key, name: entitlement.name, type: entitlement.type, allowed: false };
  }
}
