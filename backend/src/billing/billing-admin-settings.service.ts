import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingInvoiceService } from './billing-invoice.service';
import { UpdateBillingSettingsDto } from './dto/update-billing-settings.dto';
import { BillingSettings, BillingSettingsDocument } from './schemas/billing-settings.schema';

/**
 * Phase 4 admin get/update for the single BillingSettings document — see
 * that schema's singletonKey comment. Reuses
 * BillingInvoiceService.getOrCreateSettings for the read/upsert-on-first-
 * touch path rather than duplicating it.
 */
@Injectable()
export class BillingAdminSettingsService {
  constructor(
    @InjectModel(BillingSettings.name) private settingsModel: Model<BillingSettingsDocument>,
    private invoices: BillingInvoiceService,
  ) {}

  getSettings(): Promise<BillingSettingsDocument> {
    return this.invoices.getOrCreateSettings();
  }

  async updateSettings(dto: UpdateBillingSettingsDto): Promise<BillingSettingsDocument> {
    await this.invoices.getOrCreateSettings(); // ensures the singleton row exists before this update
    const settings = await this.settingsModel
      .findOneAndUpdate({ singletonKey: 'default' }, { $set: dto }, { new: true })
      .exec();
    return settings as BillingSettingsDocument;
  }
}
