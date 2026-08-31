import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateCreditPackageDto } from './dto/create-credit-package.dto';
import { UpdateCreditPackageDto } from './dto/update-credit-package.dto';
import { CreditPackage, CreditPackageDocument } from './schemas/credit-package.schema';

/**
 * Admin CRUD for the one-time "Add Credits" catalog — CreditPackage was
 * previously seeded with 5 hardcoded examples on every boot
 * (billing-seed.service.ts); that seeding is gone, so this is now the only
 * way packages come to exist. The customer-facing GET /billing/packages /
 * BillingService.initiatePurchase path is completely unchanged — this only
 * manages the same CreditPackage rows those already read.
 */
@Injectable()
export class BillingAdminPackagesService {
  constructor(@InjectModel(CreditPackage.name) private packageModel: Model<CreditPackageDocument>) {}

  listPackages() {
    return this.packageModel.find().sort({ sortOrder: 1, createdAt: 1 }).exec();
  }

  async getPackage(id: string): Promise<CreditPackageDocument> {
    const pkg = await this.packageModel.findById(id).exec();
    if (!pkg) throw new NotFoundException('Credit package not found.');
    return pkg;
  }

  async createPackage(dto: CreateCreditPackageDto): Promise<CreditPackageDocument> {
    const existing = await this.packageModel.findOne({ key: dto.key }).exec();
    if (existing) throw new BadRequestException(`A credit package with key "${dto.key}" already exists.`);
    return this.packageModel.create({ ...dto, currency: dto.currency.toUpperCase() });
  }

  async updatePackage(id: string, dto: UpdateCreditPackageDto): Promise<CreditPackageDocument> {
    const update = dto.currency ? { ...dto, currency: dto.currency.toUpperCase() } : dto;
    const pkg = await this.packageModel.findByIdAndUpdate(id, { $set: update }, { new: true }).exec();
    if (!pkg) throw new NotFoundException('Credit package not found.');
    return pkg;
  }

  async setActive(id: string, active: boolean): Promise<CreditPackageDocument> {
    const pkg = await this.packageModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).exec();
    if (!pkg) throw new NotFoundException('Credit package not found.');
    return pkg;
  }
}
