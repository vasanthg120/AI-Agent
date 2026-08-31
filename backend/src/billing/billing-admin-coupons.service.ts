import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Coupon, CouponDocument } from './schemas/coupon.schema';
import { CouponRedemption, CouponRedemptionDocument } from './schemas/coupon-redemption.schema';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

/**
 * Phase 3 admin CRUD for the coupon catalog — purely additive; a coupon has
 * zero effect until a customer actually submits its code at checkout (see
 * CouponsService, used from BillingService/BillingSubscriptionsService/
 * billing-webhook.controller.ts). Gated entirely by
 * billing-admin-coupons.controller.ts's @Roles('platform_admin').
 */
@Injectable()
export class BillingAdminCouponsService {
  constructor(
    @InjectModel(Coupon.name) private couponModel: Model<CouponDocument>,
    @InjectModel(CouponRedemption.name) private redemptionModel: Model<CouponRedemptionDocument>,
  ) {}

  listCoupons() {
    return this.couponModel.find().sort({ createdAt: -1 }).exec();
  }

  async createCoupon(dto: CreateCouponDto): Promise<CouponDocument> {
    const code = dto.code.toUpperCase().trim();
    const existing = await this.couponModel.findOne({ code }).exec();
    if (existing) throw new BadRequestException(`A coupon with code "${code}" already exists.`);
    if (dto.type === 'fixed_amount' && !dto.currencyCode) {
      throw new BadRequestException('A fixed_amount coupon requires currencyCode.');
    }
    return this.couponModel.create({
      ...dto,
      code,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
      validTo: dto.validTo ? new Date(dto.validTo) : undefined,
    });
  }

  async updateCoupon(id: string, dto: UpdateCouponDto): Promise<CouponDocument> {
    const update: Record<string, unknown> = { ...dto };
    if (dto.validFrom) update.validFrom = new Date(dto.validFrom);
    if (dto.validTo) update.validTo = new Date(dto.validTo);
    const coupon = await this.couponModel.findByIdAndUpdate(id, { $set: update }, { new: true }).exec();
    if (!coupon) throw new NotFoundException('Coupon not found.');
    return coupon;
  }

  async setActive(id: string, active: boolean): Promise<CouponDocument> {
    const coupon = await this.couponModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).exec();
    if (!coupon) throw new NotFoundException('Coupon not found.');
    return coupon;
  }

  async listRedemptions(couponId: string) {
    await this.getCoupon(couponId); // 404s if the coupon doesn't exist
    return this.redemptionModel.find({ couponId }).sort({ createdAt: -1 }).exec();
  }

  private async getCoupon(id: string): Promise<CouponDocument> {
    const coupon = await this.couponModel.findById(id).exec();
    if (!coupon) throw new NotFoundException('Coupon not found.');
    return coupon;
  }
}
