import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UpdateBillingThemeDto } from './dto/update-billing-theme.dto';
import { BillingTheme, BillingThemeDocument } from './schemas/billing-theme.schema';

/**
 * Phase 5 — the single BillingTheme document (see that schema's
 * singletonKey comment). Read by both the customer route
 * (GET /billing/theme, billing.controller.ts) and the admin route
 * (billing-admin-theme.controller.ts, which also writes).
 */
@Injectable()
export class BillingThemeService {
  constructor(@InjectModel(BillingTheme.name) private themeModel: Model<BillingThemeDocument>) {}

  getTheme(): Promise<BillingThemeDocument> {
    return this.themeModel
      .findOneAndUpdate(
        { singletonKey: 'default' },
        { $setOnInsert: { singletonKey: 'default' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  async updateTheme(dto: UpdateBillingThemeDto): Promise<BillingThemeDocument> {
    await this.getTheme(); // ensures the singleton row exists first
    const theme = await this.themeModel.findOneAndUpdate({ singletonKey: 'default' }, { $set: dto }, { new: true }).exec();
    return theme as BillingThemeDocument;
  }
}
