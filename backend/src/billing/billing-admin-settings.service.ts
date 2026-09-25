import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingAdminGatewaysService } from './billing-admin-gateways.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { UpdateBillingSettingsDto } from './dto/update-billing-settings.dto';
import { PaymentProviderKey } from './providers/payment-provider.interface';
import { BillingSettings, BillingSettingsDocument } from './schemas/billing-settings.schema';

const GATEWAY_LABELS: Record<PaymentProviderKey, string> = {
  razorpay: 'Razorpay',
  stripe: 'Stripe',
  cashfree: 'Cashfree',
};

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
    private gateways: BillingAdminGatewaysService,
  ) {}

  getSettings(): Promise<BillingSettingsDocument> {
    return this.invoices.getOrCreateSettings();
  }

  async updateSettings(dto: UpdateBillingSettingsDto): Promise<BillingSettingsDocument> {
    const current = await this.invoices.getOrCreateSettings(); // ensures the singleton row exists before this update

    // Live checkout must never silently run on a gateway that has no real
    // Live credentials on file — Test mode is left unguarded since every
    // provider already has a documented, safe simulated fallback for
    // unconfigured test/dev use (see RazorpayPaymentProvider's own comment).
    const resolvedMode = dto.defaultPaymentMode !== undefined ? dto.defaultPaymentMode : current.defaultPaymentMode;
    const resolvedProvider = ((dto.defaultPaymentProvider !== undefined ? dto.defaultPaymentProvider : current.defaultPaymentProvider) ??
      'razorpay') as PaymentProviderKey;
    if (resolvedMode === 'live') {
      const liveStatus = (await this.gateways.list()).find((g) => g.provider === resolvedProvider && g.mode === 'live');
      if (!liveStatus?.configured) {
        throw new BadRequestException(
          `${GATEWAY_LABELS[resolvedProvider] ?? resolvedProvider} does not have a configured Live account. Add Live credentials in Payment Settings before switching checkout to Live.`,
        );
      }
    }

    const settings = await this.settingsModel
      .findOneAndUpdate({ singletonKey: 'default' }, { $set: dto }, { new: true })
      .exec();
    return settings as BillingSettingsDocument;
  }
}
