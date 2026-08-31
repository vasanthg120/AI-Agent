import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { BillingAdminGatewaysService } from './billing-admin-gateways.service';
import { CashfreePaymentProvider } from './providers/cashfree-payment.provider';
import { RazorpayPaymentProvider } from './providers/razorpay-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';
import { BillingGatewayConfig, BillingGatewayConfigDocument, BillingGatewayConfigSchema } from './schemas/billing-gateway-config.schema';
import { BillingSettings, BillingSettingsDocument, BillingSettingsSchema } from './schemas/billing-settings.schema';

// Real-Mongo integration tests for Phase 8 (optional): the admin CRUD layer
// (encryption/masking) and each provider's onModuleInit DB-override — the
// actual NEW runtime behavior this phase adds, as opposed to the
// constructor's env-var path every other spec file already exercises
// unchanged. Verified via verifyWebhookSignature (pure local HMAC/SDK
// verification, no real network call to any gateway) rather than
// createCheckoutOrder, since that would need genuinely valid-looking
// gateway credentials to not error against the real API.

const TEST_PREFIX = `jest-billing-gateways-${Date.now()}`;

describe('Phase 8: DB-backed gateway config (real Mongo)', () => {
  let connection: Connection;
  let gatewaysService: BillingAdminGatewaysService;
  let gatewayConfigModel: Model<BillingGatewayConfigDocument>;
  let settingsModel: Model<BillingSettingsDocument>;
  let encryption: EncryptionService;

  const configValues: Record<string, unknown> = {
    'billing.paymentMode': 'test',
    encryptionKey: 'test-encryption-key-for-gateways-spec',
  };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: BillingGatewayConfig.name, schema: BillingGatewayConfigSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
        ]),
      ],
      providers: [BillingAdminGatewaysService, EncryptionService, { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } }],
    }).compile();

    connection = moduleRef.get(getModelToken(BillingGatewayConfig.name)).db;
    gatewaysService = moduleRef.get(BillingAdminGatewaysService);
    gatewayConfigModel = moduleRef.get(getModelToken(BillingGatewayConfig.name));
    settingsModel = moduleRef.get(getModelToken(BillingSettings.name));
    encryption = moduleRef.get(EncryptionService);
  });

  afterAll(async () => {
    await gatewayConfigModel.deleteMany({ provider: { $in: ['razorpay', 'stripe', 'cashfree'] }, mode: 'test' });
    await connection.close();
  });

  // Plain `new` + a manual onModuleInit() call — deliberately NOT a fresh
  // Nest TestingModule (and definitely not a fresh MongooseModule.forRoot)
  // per provider: four separate real Mongo connections opened back-to-back
  // in one file reliably hung this suite (each isolated `it` block passed
  // fine alone; only running the file's full 7 tests together hung,
  // confirming it was connection accumulation, not the actual onModuleInit
  // logic under test). Every provider class's constructor/onModuleInit are
  // plain TypeScript, so direct instantiation against the ONE shared
  // gatewayConfigModel/connection this file already opened is both
  // sufficient and far cheaper than spinning up a full DI container per case.
  const configStub = { get: (key: string) => configValues[key] } as unknown as ConfigService;
  function instantiate<T>(
    ProviderClass: new (
      config: ConfigService,
      encryption: EncryptionService,
      gatewayConfigModel: Model<BillingGatewayConfigDocument>,
      settingsModel: Model<BillingSettingsDocument>,
    ) => T,
  ): T {
    return new ProviderClass(configStub, encryption, gatewayConfigModel, settingsModel);
  }

  describe('BillingAdminGatewaysService', () => {
    it('encrypts credentials on upsert and never returns them decrypted from list()', async () => {
      await gatewaysService.upsert('razorpay', 'test', { keyId: 'rzp_test_abcd1234', keySecret: 'super-secret-value', webhookSecret: 'whsec_1' });

      const rows = await gatewaysService.list();
      const row = rows.find((r) => r.provider === 'razorpay' && r.mode === 'test');
      expect(row).toBeTruthy();
      expect(row?.configured).toBe(true);
      expect(row?.maskedKeyId).toBe('••••1234');
      expect(JSON.stringify(row)).not.toContain('super-secret-value');
      expect(JSON.stringify(row)).not.toContain('rzp_test_abcd1234'); // full value never leaks either, only the masked tail

      const raw = await gatewayConfigModel.findOne({ provider: 'razorpay', mode: 'test' }).exec();
      expect(raw?.credentialsEncrypted.keySecret).not.toBe('super-secret-value'); // stored ciphertext, not plaintext
      expect(encryption.decrypt(raw!.credentialsEncrypted.keySecret)).toBe('super-secret-value'); // but round-trips correctly
    });

    it('upserting the same (provider, mode) twice updates in place, never duplicates', async () => {
      await gatewaysService.upsert('stripe', 'test', { secretKey: 'sk_test_first' });
      await gatewaysService.upsert('stripe', 'test', { secretKey: 'sk_test_second' });

      const count = await gatewayConfigModel.countDocuments({ provider: 'stripe', mode: 'test' });
      expect(count).toBe(1);
      const raw = await gatewayConfigModel.findOne({ provider: 'stripe', mode: 'test' }).exec();
      expect(encryption.decrypt(raw!.credentialsEncrypted.secretKey)).toBe('sk_test_second');
    });

    it('setActive toggles isActive and is reflected by list()', async () => {
      await gatewaysService.upsert('cashfree', 'test', { clientId: 'cf_test_client', clientSecret: 'cf_secret' });
      await gatewaysService.setActive('cashfree', 'test', false);
      let rows = await gatewaysService.list();
      expect(rows.find((r) => r.provider === 'cashfree')?.isActive).toBe(false);

      await gatewaysService.setActive('cashfree', 'test', true);
      rows = await gatewaysService.list();
      expect(rows.find((r) => r.provider === 'cashfree')?.isActive).toBe(true);
    });
  });

  describe('provider onModuleInit — additive DB override', () => {
    it('RazorpayPaymentProvider: no DB row leaves the unconfigured (simulated) constructor behavior untouched', async () => {
      await gatewayConfigModel.deleteMany({ provider: 'razorpay', mode: 'test' });
      const provider = instantiate(RazorpayPaymentProvider);
      await provider.onModuleInit();
      // No env keys configured in this test's ConfigService stub and no
      // BillingGatewayConfig row for this provider -> still simulated:
      // verifyWebhookSignature short-circuits true regardless of the header.
      expect(provider.verifyWebhookSignature(Buffer.from('body'), 'not-a-real-signature')).toBe(true);
    });

    it('RazorpayPaymentProvider: an active DB row overrides the webhook secret used for verification', async () => {
      await gatewayConfigModel.deleteMany({ provider: 'razorpay', mode: 'test' });
      await gatewaysService.upsert('razorpay', 'test', { keyId: 'rzp_test_override', keySecret: 'override-secret', webhookSecret: 'override-webhook-secret' });

      const provider = instantiate(RazorpayPaymentProvider);
      await provider.onModuleInit();

      const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
      const wrongSignature = 'deadbeef';
      const correctSignature = createHmac('sha256', 'override-webhook-secret').update(body).digest('hex');

      expect(provider.verifyWebhookSignature(body, wrongSignature)).toBe(false); // now actually checking HMAC, not simulated-true
      expect(provider.verifyWebhookSignature(body, correctSignature)).toBe(true);
    });

    it('StripePaymentProvider: an active DB row overrides the webhook secret used for verification', async () => {
      await gatewayConfigModel.deleteMany({ provider: 'stripe', mode: 'test' });
      await gatewaysService.upsert('stripe', 'test', { secretKey: 'sk_test_override', webhookSecret: 'stripe-override-secret' });

      const provider = instantiate(StripePaymentProvider);
      await provider.onModuleInit();

      const body = Buffer.from(JSON.stringify({ type: 'payment_intent.succeeded' }));
      expect(provider.verifyWebhookSignature(body, 'not-a-real-stripe-signature')).toBe(false);
    });

    it('CashfreePaymentProvider: no DB row leaves the unconfigured (simulated) constructor behavior untouched', async () => {
      await gatewayConfigModel.deleteMany({ provider: 'cashfree', mode: 'test' });
      const provider = instantiate(CashfreePaymentProvider);
      await provider.onModuleInit();
      expect(provider.verifyWebhookSignature(Buffer.from('body'), 'anything')).toBe(true);
    });
  });
});
