import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InvoiceTemplate, InvoiceTemplateDocument } from './schemas/invoice-template.schema';
import { CreateInvoiceTemplateDto } from './dto/create-invoice-template.dto';
import { UpdateInvoiceTemplateDto } from './dto/update-invoice-template.dto';

/**
 * Phase 4 admin CRUD for the invoice template catalog — see
 * schemas/invoice-template.schema.ts for why this is a bundle of layout
 * toggles, not free HTML. Gated entirely by
 * billing-admin-templates.controller.ts's @Roles('platform_admin').
 */
@Injectable()
export class BillingAdminTemplatesService {
  constructor(@InjectModel(InvoiceTemplate.name) private templateModel: Model<InvoiceTemplateDocument>) {}

  listTemplates() {
    return this.templateModel.find().sort({ createdAt: -1 }).exec();
  }

  async createTemplate(dto: CreateInvoiceTemplateDto): Promise<InvoiceTemplateDocument> {
    const existing = await this.templateModel.findOne({ key: dto.key }).exec();
    if (existing) throw new BadRequestException(`A template with key "${dto.key}" already exists.`);
    if (dto.isDefault) await this.clearExistingDefault();
    return this.templateModel.create(dto);
  }

  async updateTemplate(id: string, dto: UpdateInvoiceTemplateDto): Promise<InvoiceTemplateDocument> {
    if (dto.isDefault) await this.clearExistingDefault();
    const template = await this.templateModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!template) throw new NotFoundException('Template not found.');
    return template;
  }

  async setActive(id: string, active: boolean): Promise<InvoiceTemplateDocument> {
    const template = await this.templateModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).exec();
    if (!template) throw new NotFoundException('Template not found.');
    return template;
  }

  /** Exactly one template has isDefault:true at a time — same
   * unset-every-other-row-first pattern as
   * BillingAdminCurrenciesService.clearExistingDefault. */
  private async clearExistingDefault(): Promise<void> {
    await this.templateModel.updateMany({ isDefault: true }, { $set: { isDefault: false } });
  }
}
