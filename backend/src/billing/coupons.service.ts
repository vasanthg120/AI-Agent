import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Coupon, CouponDocument } from './schemas/coupon.schema';
import { CouponRedemption, CouponRedemptionDocument } from './schemas/coupon-redemption.schema';
import { PaymentRecordDocument } from './schemas/payment-record.schema';

export interface CouponApplication {
  coupon: CouponDocument;
  discountAmount: number;
  bonusCredits: number;
}

/**
 * Phase 3 — shared by BillingService (credit-package purchases),
 * BillingSubscriptionsService (subscription checkout), and
 * billing-webhook.controller.ts (the async-webhook confirmation path for
 * both). A coupon only ever discounts/bonuses the ONE checkout it was
 * applied to — validate() is called at checkout-initiation time to compute
 * the adjusted amount/credits (locked into the PaymentRecord, see that
 * schema's couponId/couponDiscountAmount/couponBonusCredits fields);
 * recordRedemption() is called only once that specific payment is actually
 * confirmed, which is what maxRedemptions/maxRedemptionsPerOrg count against
 * — a coupon code that was merely typed in and abandoned mid-checkout never
 * consumes a redemption.
 */
@Injectable()
export class CouponsService {
  constructor(
    @InjectModel(Coupon.name) private couponModel: Model<CouponDocument>,
    @InjectModel(CouponRedemption.name) private redemptionModel: Model<CouponRedemptionDocument>,
  ) {}

  async validate(
    code: string,
    opts: { organizationId: string; context: 'subscription_checkout' | 'credit_purchase'; planId?: string; amount: number; currencyCode: string },
  ): Promise<CouponApplication> {
    const normalizedCode = code.toUpperCase().trim();
    const coupon = await this.couponModel.findOne({ code: normalizedCode, active: true }).exec();
    if (!coupon) throw new BadRequestException(`Coupon "${code}" is not valid.`);

    const now = new Date();
    if (coupon.validFrom && coupon.validFrom > now) throw new BadRequestException(`Coupon "${code}" is not active yet.`);
    if (coupon.validTo && coupon.validTo < now) throw new BadRequestException(`Coupon "${code}" has expired.`);

    const applicableContext = opts.context === 'subscription_checkout' ? 'plans' : 'packages';
    if (coupon.appliesTo !== 'all' && coupon.appliesTo !== applicableContext) {
      throw new BadRequestException(`Coupon "${code}" cannot be used for this type of purchase.`);
    }
    if (opts.context === 'subscription_checkout' && coupon.applicablePlanIds.length > 0) {
      if (!opts.planId || !coupon.applicablePlanIds.includes(opts.planId)) {
        throw new BadRequestException(`Coupon "${code}" is not valid for this plan.`);
      }
    }

    if (coupon.maxRedemptions !== undefined && coupon.maxRedemptions !== null) {
      const totalRedemptions = await this.redemptionModel.countDocuments({ couponId: coupon._id.toString() });
      if (totalRedemptions >= coupon.maxRedemptions) {
        throw new BadRequestException(`Coupon "${code}" has reached its total redemption limit.`);
      }
    }
    const orgRedemptions = await this.redemptionModel.countDocuments({
      couponId: coupon._id.toString(),
      organizationId: opts.organizationId,
    });
    if (orgRedemptions >= coupon.maxRedemptionsPerOrg) {
      throw new BadRequestException(`Coupon "${code}" has already been used the maximum number of times for this organization.`);
    }

    let discountAmount = 0;
    let bonusCredits = 0;
    if (coupon.type === 'percentage') {
      discountAmount = Math.min(opts.amount, Math.round(opts.amount * (coupon.value / 100) * 100) / 100);
    } else if (coupon.type === 'fixed_amount') {
      if (!coupon.currencyCode || coupon.currencyCode.toUpperCase() !== opts.currencyCode.toUpperCase()) {
        throw new BadRequestException(`Coupon "${code}" is not valid in ${opts.currencyCode}.`);
      }
      discountAmount = Math.min(opts.amount, coupon.value);
    } else {
      // free_credits — no price discount at all, only a bonus credits grant.
      bonusCredits = coupon.value;
    }

    return { coupon, discountAmount, bonusCredits };
  }

  /** Writes the CouponRedemption row a completed payment earns — the
   * `paymentRecordId` unique index is the idempotency guard (mirrors this
   * codebase's established insert-then-catch-duplicate-key convention, e.g.
   * billing-webhook.controller.ts's WebhookEvent), so calling this twice
   * for the same PaymentRecord (a confirm()/webhook race, or any other
   * double-invocation) is a safe no-op rather than double-counting a
   * redemption. No-ops entirely if the record carries no couponId. */
  async recordRedemption(record: PaymentRecordDocument, redeemedBy: string, context: 'subscription_checkout' | 'credit_purchase'): Promise<void> {
    if (!record.couponId) return;
    try {
      await this.redemptionModel.create({
        couponId: record.couponId,
        organizationId: record.organizationId,
        redeemedBy,
        context,
        subscriptionId: record.subscriptionId,
        paymentRecordId: record._id.toString(),
        amountDiscounted: record.couponDiscountAmount ?? 0,
        bonusCredits: record.couponBonusCredits ?? 0,
      });
    } catch (err) {
      const mongoErr = err as { code?: number };
      if (mongoErr.code !== 11000) throw err;
      // Already recorded by a concurrent confirm()/webhook race — fine.
    }
  }
}
