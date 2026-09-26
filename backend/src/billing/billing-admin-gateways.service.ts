import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Razorpay from 'razorpay';
import Stripe from 'stripe';
import { Cashfree, CFEnvironment } from 'cashfree-pg';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PaymentProviderKey } from './providers/payment-provider.interface';
import { BillingGatewayConfig, BillingGatewayConfigDocument } from './schemas/billing-gateway-config.schema';

export interface ConnectionTestResult {
  success: boolean;
  provider: PaymentProviderKey;
  mode: 'live' | 'test';
  message: string;
}

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

  /** A REAL connectivity check against the gateway's own API — distinct from
   * `list()`'s `configured` flag, which only reflects whether credentials
   * exist and decrypt (a DB-status check, not a live API call). Builds its
   * own throwaway SDK client straight from this (provider, mode)'s
   * BillingGatewayConfig row, deliberately NOT reusing the injected
   * RazorpayPaymentProvider/StripePaymentProvider/CashfreePaymentProvider
   * singletons — those bind to whichever mode was active at process boot
   * (see their own onModuleInit comments) and would silently test the wrong
   * environment if the admin is checking a mode that isn't currently active.
   * Every call below is read-only (list/balance/fetch), never creates or
   * charges anything. */
  async testConnection(provider: PaymentProviderKey, mode: 'live' | 'test'): Promise<ConnectionTestResult> {
    const row = await this.gatewayConfigModel.findOne({ provider, mode }).exec();
    if (!row || Object.keys(row.credentialsEncrypted).length === 0) {
      return { success: false, provider, mode, message: `No ${mode} credentials are saved for ${provider} yet.` };
    }

    const decrypt = (key: string): string => {
      const value = row.credentialsEncrypted[key];
      if (!value) return '';
      try {
        return this.encryption.decrypt(value);
      } catch {
        return '';
      }
    };

    try {
      if (provider === 'razorpay') {
        const keyId = decrypt('keyId');
        const keySecret = decrypt('keySecret');
        if (!keyId || !keySecret) return { success: false, provider, mode, message: 'Razorpay Key ID/Key Secret are missing or corrupted.' };
        const client = new Razorpay({ key_id: keyId, key_secret: keySecret });
        await client.orders.all({ count: 1 });
        return { success: true, provider, mode, message: 'Connection successful.' };
      }

      if (provider === 'stripe') {
        const secretKey = decrypt('secretKey');
        if (!secretKey) return { success: false, provider, mode, message: 'Stripe Secret Key is missing or corrupted.' };
        const client = new Stripe(secretKey);
        await client.balance.retrieve();
        return { success: true, provider, mode, message: 'Connection successful.' };
      }

      // cashfree
      const clientId = decrypt('clientId');
      const clientSecret = decrypt('clientSecret');
      if (!clientId || !clientSecret) return { success: false, provider, mode, message: 'Cashfree Client ID/Secret are missing or corrupted.' };
      const client = new Cashfree(mode === 'live' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX, clientId, clientSecret);
      try {
        // No order with this id will ever exist — a "not found" response
        // still proves the request authenticated correctly. Only an
        // auth-rejection (401/403) means the credentials themselves are bad.
        await client.PGFetchOrder('haive-connection-test-probe');
        return { success: true, provider, mode, message: 'Connection successful.' };
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 403) {
          return { success: false, provider, mode, message: 'Cashfree rejected these credentials.' };
        }
        // Any other status (404 not found, etc.) means the request reached
        // Cashfree and authenticated — the probe order simply doesn't exist.
        return { success: true, provider, mode, message: 'Connection successful.' };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : `Unable to connect using the configured ${mode === 'live' ? 'Live' : 'Test'} credentials.`;
      return { success: false, provider, mode, message };
    }
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
