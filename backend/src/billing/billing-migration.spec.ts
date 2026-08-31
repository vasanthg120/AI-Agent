import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Organization, OrganizationDocument, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { BillingMigrationService } from './billing-migration.service';
import { CreditReservation, CreditReservationDocument, CreditReservationSchema } from './schemas/credit-reservation.schema';
import { PaymentMethod, PaymentMethodDocument, PaymentMethodSchema } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument, PaymentRecordSchema } from './schemas/payment-record.schema';
import { Wallet, WalletDocument, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';

// Real-Mongo integration tests (this project's established live-testing
// convention — see jest.setup.js and billing-integration.spec.ts) for the
// Phase 0 org-scoping migration (billing-migration.service.ts). Covers the
// plan's required cases: single-wallet rename, multi-wallet merge
// correctness, dry-run producing zero writes, and re-run idempotency.

const TEST_PREFIX = `jest-billing-migration-${Date.now()}`;

describe('BillingMigrationService (real Mongo)', () => {
  let connection: Connection;
  let migrationService: BillingMigrationService;
  let orgModel: Model<OrganizationDocument>;
  let userModel: Model<UserDocument>;
  let walletModel: Model<WalletDocument>;
  let transactionModel: Model<WalletTransactionDocument>;
  let reservationModel: Model<CreditReservationDocument>;
  let paymentRecordModel: Model<PaymentRecordDocument>;
  let paymentMethodModel: Model<PaymentMethodDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run billing migration integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Organization.name, schema: OrganizationSchema },
          { name: User.name, schema: UserSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: CreditReservation.name, schema: CreditReservationSchema },
          { name: PaymentRecord.name, schema: PaymentRecordSchema },
          { name: PaymentMethod.name, schema: PaymentMethodSchema },
        ]),
      ],
      providers: [BillingMigrationService],
    }).compile();

    connection = moduleRef.get(getModelToken(Organization.name)).db;
    migrationService = moduleRef.get(BillingMigrationService);
    orgModel = moduleRef.get(getModelToken(Organization.name));
    userModel = moduleRef.get(getModelToken(User.name));
    walletModel = moduleRef.get(getModelToken(Wallet.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    reservationModel = moduleRef.get(getModelToken(CreditReservation.name));
    paymentRecordModel = moduleRef.get(getModelToken(PaymentRecord.name));
    paymentMethodModel = moduleRef.get(getModelToken(PaymentMethod.name));
  });

  afterAll(async () => {
    await orgModel.deleteMany({ slug: { $regex: `^${TEST_PREFIX}` } });
    await userModel.deleteMany({ email: { $regex: `^${TEST_PREFIX}` } });
    await walletModel.deleteMany({ organizationId: { $regex: TEST_PREFIX } });
    await transactionModel.deleteMany({ organizationId: { $regex: TEST_PREFIX } });
    await reservationModel.deleteMany({ organizationId: { $regex: TEST_PREFIX } });
    await paymentRecordModel.deleteMany({ organizationId: { $regex: TEST_PREFIX } });
    await paymentMethodModel.deleteMany({ organizationId: { $regex: TEST_PREFIX } });
    await connection.close();
  });

  describe('Single-wallet rename', () => {
    it('renames the one user-keyed wallet onto the real organizationId, balance untouched', async () => {
      const org = await orgModel.create({ name: 'Rename Org', slug: `${TEST_PREFIX}-rename-org` });
      const user = await userModel.create({
        email: `${TEST_PREFIX}-rename@example.com`,
        name: 'Rename User',
        organizationId: org._id.toString(),
        roles: ['owner', 'admin'],
      });
      const wallet = await walletModel.create({ organizationId: user._id.toString(), balanceCredits: 50, reservedCredits: 0 });

      // Dry run must write nothing.
      const dry = await migrationService.run({ dryRun: true, organizationId: org._id.toString() });
      expect(dry.organizations).toHaveLength(1);
      expect(dry.organizations[0].action).toBe('rename');
      const untouched = await walletModel.findById(wallet._id);
      expect(untouched?.organizationId).toBe(user._id.toString()); // still keyed by user id

      // Real run performs the rename.
      const real = await migrationService.run({ dryRun: false, organizationId: org._id.toString() });
      expect(real.organizations[0].action).toBe('rename');
      const renamed = await walletModel.findById(wallet._id);
      expect(renamed?.organizationId).toBe(org._id.toString());
      expect(renamed?.balanceCredits).toBe(50); // untouched by the rename

      // Re-run is a no-op (idempotent).
      const rerun = await migrationService.run({ dryRun: false, organizationId: org._id.toString() });
      expect(rerun.organizations[0].action).toBe('none');
    });
  });

  describe('Multi-wallet merge', () => {
    it('merges every teammate wallet into the owner wallet, repoints dependents, and is idempotent on re-run', async () => {
      const org = await orgModel.create({ name: 'Merge Org', slug: `${TEST_PREFIX}-merge-org` });
      const owner = await userModel.create({
        email: `${TEST_PREFIX}-owner@example.com`,
        name: 'Owner User',
        organizationId: org._id.toString(),
        roles: ['owner', 'admin'],
      });
      const member = await userModel.create({
        email: `${TEST_PREFIX}-member@example.com`,
        name: 'Member User',
        organizationId: org._id.toString(),
        roles: ['user'],
      });

      const ownerWallet = await walletModel.create({ organizationId: owner._id.toString(), balanceCredits: 100, reservedCredits: 10 });
      const memberWallet = await walletModel.create({ organizationId: member._id.toString(), balanceCredits: 30, reservedCredits: 5 });

      await transactionModel.create({
        organizationId: member._id.toString(),
        walletId: memberWallet._id.toString(),
        type: 'PURCHASE',
        amountCredits: 30,
        balanceAfterCredits: 30,
        createdBy: member._id.toString(),
      });
      const reservation = await reservationModel.create({
        organizationId: member._id.toString(),
        walletId: memberWallet._id.toString(),
        requestId: `${TEST_PREFIX}-req-1`,
        conversationId: `${TEST_PREFIX}-conv-1`,
        userId: member._id.toString(),
        estimatedCredits: 5,
        status: 'pending',
        expiresAt: new Date(Date.now() + 600_000),
      });
      const paymentRecord = await paymentRecordModel.create({
        organizationId: member._id.toString(),
        walletId: memberWallet._id.toString(),
        type: 'purchase',
        provider: 'razorpay',
        gatewayOrderId: `${TEST_PREFIX}-order-1`,
        amount: 30,
        currency: 'INR',
        creditsGranted: 30,
        status: 'captured',
      });
      await paymentMethodModel.create({
        organizationId: owner._id.toString(),
        provider: 'razorpay',
        gatewayCustomerId: 'cust-owner',
        gatewayTokenIdEncrypted: 'enc-owner',
        cardLast4: '1111',
        cardNetwork: 'visa',
        isDefault: true,
      });
      const memberMethod = await paymentMethodModel.create({
        organizationId: member._id.toString(),
        provider: 'razorpay',
        gatewayCustomerId: 'cust-member',
        gatewayTokenIdEncrypted: 'enc-member',
        cardLast4: '2222',
        cardNetwork: 'visa',
        isDefault: true,
      });

      // Dry run: correct plan, zero writes.
      const dry = await migrationService.run({ dryRun: true, organizationId: org._id.toString() });
      const dryPlan = dry.organizations[0];
      expect(dryPlan.action).toBe('merge');
      expect(dryPlan.targetWalletId).toBe(ownerWallet._id.toString());
      expect(dryPlan.mergedBalanceCredits).toBe(130);
      expect(dryPlan.mergedReservedCredits).toBe(15);
      expect((await walletModel.findById(memberWallet._id))?.organizationId).toBe(member._id.toString());

      // Real run: performs the merge.
      await migrationService.run({ dryRun: false, organizationId: org._id.toString() });

      const target = await walletModel.findById(ownerWallet._id);
      expect(target?.organizationId).toBe(org._id.toString());
      expect(target?.balanceCredits).toBe(130); // 100 + 30
      expect(target?.reservedCredits).toBe(15); // 10 + 5

      const archivedSource = await walletModel.findById(memberWallet._id);
      expect(archivedSource?.organizationId).toBe(`migrated:${member._id.toString()}`);
      expect(archivedSource?.migratedAt).toBeInstanceOf(Date);
      expect(archivedSource?.migratedIntoOrganizationId).toBe(org._id.toString());

      const repointedTx = await transactionModel.findOne({ walletId: ownerWallet._id.toString(), type: 'PURCHASE' });
      expect(repointedTx?.organizationId).toBe(org._id.toString());

      const repointedReservation = await reservationModel.findById(reservation._id);
      expect(repointedReservation?.organizationId).toBe(org._id.toString());
      expect(repointedReservation?.walletId).toBe(ownerWallet._id.toString());

      const repointedPayment = await paymentRecordModel.findById(paymentRecord._id);
      expect(repointedPayment?.organizationId).toBe(org._id.toString());
      expect(repointedPayment?.walletId).toBe(ownerWallet._id.toString());

      // Exactly one payment method stays default — the most recently created.
      const methods = await paymentMethodModel.find({ organizationId: org._id.toString() });
      expect(methods).toHaveLength(2);
      const defaults = methods.filter((m) => m.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]._id.toString()).toBe(memberMethod._id.toString());

      // Auditable merge ledger row exists on the target.
      const auditRow = await transactionModel.findOne({
        walletId: ownerWallet._id.toString(),
        type: 'MANUAL_ADJUSTMENT',
        'metadata.migration': true,
      });
      expect(auditRow).toBeTruthy();
      expect(auditRow?.amountCredits).toBe(0);

      // Re-run is a no-op (idempotent) — nothing left keyed by a user id.
      const rerun = await migrationService.run({ dryRun: false, organizationId: org._id.toString() });
      expect(rerun.organizations[0].action).toBe('none');
      const targetAfterRerun = await walletModel.findById(ownerWallet._id);
      expect(targetAfterRerun?.balanceCredits).toBe(130); // unchanged — not merged a second time
    });
  });
});
