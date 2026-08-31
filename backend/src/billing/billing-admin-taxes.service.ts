import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TaxRate, TaxRateDocument } from './schemas/tax-rate.schema';
import { CreateTaxRateDto } from './dto/create-tax-rate.dto';
import { UpdateTaxRateDto } from './dto/update-tax-rate.dto';

/**
 * Phase 1 admin CRUD for the tax-rate catalog — purely additive; nothing
 * applies these rates to a price yet (a future checkout/invoice flow is the
 * intended consumer). Gated entirely by
 * billing-admin-taxes.controller.ts's @Roles('platform_admin').
 */
@Injectable()
export class BillingAdminTaxesService {
  constructor(@InjectModel(TaxRate.name) private taxRateModel: Model<TaxRateDocument>) {}

  listTaxRates() {
    return this.taxRateModel.find().sort({ key: 1 }).exec();
  }

  async createTaxRate(dto: CreateTaxRateDto): Promise<TaxRateDocument> {
    const existing = await this.taxRateModel.findOne({ key: dto.key }).exec();
    if (existing) throw new BadRequestException(`A tax rate with key "${dto.key}" already exists.`);
    return this.taxRateModel.create(dto);
  }

  async updateTaxRate(id: string, dto: UpdateTaxRateDto): Promise<TaxRateDocument> {
    const taxRate = await this.taxRateModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!taxRate) throw new NotFoundException('Tax rate not found.');
    return taxRate;
  }

  async setActive(id: string, active: boolean): Promise<TaxRateDocument> {
    const taxRate = await this.taxRateModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).exec();
    if (!taxRate) throw new NotFoundException('Tax rate not found.');
    return taxRate;
  }
}
