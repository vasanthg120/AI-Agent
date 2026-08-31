import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UpdateBillingPageConfigDto } from './dto/update-billing-page-config.dto';
import { BillingPageConfig, BillingPageConfigDocument } from './schemas/billing-page-config.schema';

/**
 * Phase 5 — the single BillingPageConfig document (see that schema's
 * singletonKey comment). Read by both the customer route
 * (GET /billing/page-config, billing.controller.ts) and the admin route
 * (billing-admin-page-config.controller.ts, which also writes).
 */
@Injectable()
export class BillingPageConfigService {
  constructor(@InjectModel(BillingPageConfig.name) private configModel: Model<BillingPageConfigDocument>) {}

  getPageConfig(): Promise<BillingPageConfigDocument> {
    return this.configModel
      .findOneAndUpdate(
        { singletonKey: 'default' },
        { $setOnInsert: { singletonKey: 'default' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  async updatePageConfig(dto: UpdateBillingPageConfigDto): Promise<BillingPageConfigDocument> {
    await this.getPageConfig(); // ensures the singleton row exists first
    const config = await this.configModel.findOneAndUpdate({ singletonKey: 'default' }, { $set: dto }, { new: true }).exec();
    return config as BillingPageConfigDocument;
  }
}
