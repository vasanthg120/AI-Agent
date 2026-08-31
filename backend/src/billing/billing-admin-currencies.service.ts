import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Currency, CurrencyDocument } from './schemas/currency.schema';
import { CreateCurrencyDto } from './dto/create-currency.dto';
import { UpdateCurrencyDto } from './dto/update-currency.dto';

/**
 * Phase 1 admin CRUD for the currency catalog — purely additive; nothing
 * customer-facing reads this yet (config.billing.currency/usdToCurrencyRate
 * remain the platform default until a later phase wires currency selection
 * into checkout). Gated entirely by
 * billing-admin-currencies.controller.ts's @Roles('platform_admin').
 */
@Injectable()
export class BillingAdminCurrenciesService {
  constructor(@InjectModel(Currency.name) private currencyModel: Model<CurrencyDocument>) {}

  listCurrencies() {
    return this.currencyModel.find().sort({ code: 1 }).exec();
  }

  async createCurrency(dto: CreateCurrencyDto): Promise<CurrencyDocument> {
    const code = dto.code.toUpperCase();
    const existing = await this.currencyModel.findOne({ code }).exec();
    if (existing) throw new BadRequestException(`Currency "${code}" already exists.`);
    if (dto.isDefault) await this.clearExistingDefault();
    return this.currencyModel.create({ ...dto, code });
  }

  async updateCurrency(id: string, dto: UpdateCurrencyDto): Promise<CurrencyDocument> {
    if (dto.isDefault) await this.clearExistingDefault();
    const currency = await this.currencyModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!currency) throw new NotFoundException('Currency not found.');
    return currency;
  }

  async setActive(id: string, active: boolean): Promise<CurrencyDocument> {
    const currency = await this.currencyModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).exec();
    if (!currency) throw new NotFoundException('Currency not found.');
    return currency;
  }

  /** Exactly one Currency has isDefault:true at a time — same
   * unset-every-other-row-first pattern billing-migration.service.ts uses
   * for PaymentMethod.isDefault. */
  private async clearExistingDefault(): Promise<void> {
    await this.currencyModel.updateMany({ isDefault: true }, { $set: { isDefault: false } });
  }
}
