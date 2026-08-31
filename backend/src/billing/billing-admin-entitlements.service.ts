import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateEntitlementDto } from './dto/create-entitlement.dto';
import { UpdateEntitlementDto } from './dto/update-entitlement.dto';
import { Entitlement, EntitlementDocument } from './schemas/entitlement.schema';

/**
 * Admin CRUD for the Entitlement catalog (Phase 0 of the ChatGPT-style
 * billing migration — see entitlements.service.ts). Mirrors
 * BillingAdminPackagesService's exact create/update/setActive shape. A
 * plan's actual grants against this catalog live embedded on BillingPlan
 * (billing-admin-plans.service.ts's existing updatePlan already handles the
 * new `entitlements` field generically via $set).
 */
@Injectable()
export class BillingAdminEntitlementsService {
  constructor(@InjectModel(Entitlement.name) private entitlementModel: Model<EntitlementDocument>) {}

  listEntitlements() {
    return this.entitlementModel.find().sort({ createdAt: 1 }).exec();
  }

  async getEntitlement(id: string): Promise<EntitlementDocument> {
    const entitlement = await this.entitlementModel.findById(id).exec();
    if (!entitlement) throw new NotFoundException('Entitlement not found.');
    return entitlement;
  }

  async createEntitlement(dto: CreateEntitlementDto): Promise<EntitlementDocument> {
    const existing = await this.entitlementModel.findOne({ key: dto.key }).exec();
    if (existing) throw new BadRequestException(`An entitlement with key "${dto.key}" already exists.`);
    return this.entitlementModel.create(dto);
  }

  async updateEntitlement(id: string, dto: UpdateEntitlementDto): Promise<EntitlementDocument> {
    const entitlement = await this.entitlementModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!entitlement) throw new NotFoundException('Entitlement not found.');
    return entitlement;
  }

  async setActive(id: string, active: boolean): Promise<EntitlementDocument> {
    const entitlement = await this.entitlementModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).exec();
    if (!entitlement) throw new NotFoundException('Entitlement not found.');
    return entitlement;
  }
}
