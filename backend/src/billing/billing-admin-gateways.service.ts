import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PaymentProviderKey } from './providers/payment-provider.interface';
import { BillingGatewayConfig, BillingGatewayConfigDocument } from './schemas/billing-gateway-config.schema';

export interface GatewayConfigStatus {
  provider: PaymentProviderKey;
  mode: 'live' | 'test';
  configured: boolean;
  isActive: boolean;
  // Last 4 characters of the primary (non-secret) identifying credential
  // only — keyId/publishableKey/clientId, never keySecret/secretKey/
  // clientSecret/webhookSecret. This route never returns a decrypted
  // secret value, full or partial.
  maskedKeyId?: string;
  updatedAt?: Date;
}

const PRIMARY_KEY_FIELD: Record<PaymentProviderKey, string> = {
  razorpay: 'keyId',
  stripe: 'publishableKey',
  cashfree: 'clientId',
};

/**
 * Phase 8 (optional) admin CRUD for DB-backed gateway credentials — see
 * schemas/billing-gateway-config.schema.ts for why this is additive
 * (env vars keep working) and restart-to-take-effect (no live SDK client
 * hot-reload). Gated entirely by
 * billing-admin-gateways.controller.ts's @Roles('platform_admin') — the
 * only admin surface in this module that ever accepts raw secret values
 * over the wire (encrypted immediately, never returned).
 */
@Injectable()
export class BillingAdminGatewaysService {
  constructor(
    @InjectModel(BillingGatewayConfig.name) private gatewayConfigModel: Model<BillingGatewayConfigDocument>,
    private encryption: EncryptionService,
  ) {}

  async list(): Promise<GatewayConfigStatus[]> {
    const rows = await this.gatewayConfigModel.find().exec();
    return rows.map((row) => this.toStatus(row));
  }

  async upsert(provider: PaymentProviderKey, mode: 'live' | 'test', credentials: Record<string, string>): Promise<GatewayConfigStatus> {
    const credentialsEncrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (value) credentialsEncrypted[key] = this.encryption.encrypt(value);
    }
    const row = await this.gatewayConfigModel
      .findOneAndUpdate(
        { provider, mode },
        { $set: { credentialsEncrypted }, $setOnInsert: { provider, mode, isActive: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return this.toStatus(row);
  }

  async setActive(provider: PaymentProviderKey, mode: 'live' | 'test', isActive: boolean): Promise<GatewayConfigStatus> {
    const row = await this.gatewayConfigModel.findOneAndUpdate({ provider, mode }, { $set: { isActive } }, { new: true }).exec();
    if (!row) throw new NotFoundException(`No ${mode}-mode configuration on file for ${provider}.`);
    return this.toStatus(row);
  }

  private toStatus(row: BillingGatewayConfigDocument): GatewayConfigStatus {
    const primaryField = PRIMARY_KEY_FIELD[row.provider];
    const encryptedPrimary = row.credentialsEncrypted[primaryField];
    let maskedKeyId: string | undefined;
    if (encryptedPrimary) {
      try {
        const decrypted = this.encryption.decrypt(encryptedPrimary);
        maskedKeyId = decrypted.length > 4 ? `••••${decrypted.slice(-4)}` : '••••';
      } catch {
        maskedKeyId = undefined; // corrupted/undecryptable row — surfaced as "not configured" below, not an error
      }
    }
    return {
      provider: row.provider,
      mode: row.mode,
      configured: Object.keys(row.credentialsEncrypted).length > 0 && Boolean(maskedKeyId),
      isActive: row.isActive,
      maskedKeyId,
      updatedAt: (row as unknown as { updatedAt?: Date }).updatedAt,
    };
  }
}
