import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Organization, OrganizationDocument } from '../organizations/schemas/organization.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { CreditReservation, CreditReservationDocument } from './schemas/credit-reservation.schema';
import { PaymentMethod, PaymentMethodDocument } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument } from './schemas/wallet-transaction.schema';

export interface WalletMergeSourceSummary {
  walletId: string;
  originalKey: string;
  balanceCredits: number;
  reservedCredits: number;
}

export interface OrganizationMigrationPlan {
  organizationId: string;
  action: 'none' | 'rename' | 'merge';
  sourceWallets: WalletMergeSourceSummary[];
  targetWalletId?: string;
  mergedBalanceCredits?: number;
  mergedReservedCredits?: number;
}

export interface MigrationRunResult {
  dryRun: boolean;
  organizations: OrganizationMigrationPlan[];
}

/**
 * Phase 0 of the org-scoped billing extension — see billing.controller.ts's
 * tenantKey() for the read/write switch this backs. Today, every wallet is
 * keyed by a single user's id (billing.controller.ts passes user.sub as the
 * tenant key); this service repoints wallets — and everything hanging off
 * them — onto the real organizationId, so BILLING_ORG_SCOPED_WALLETS=true
 * can be safely flipped afterwards.
 *
 * `run()` is always safe to call with dryRun:true (the default from the
 * controller) — it only reads. dryRun:false performs real, mostly
 * irreversible writes; see wallet.schema.ts's migratedAt/
 * migratedIntoOrganizationId for the audit trail a rollback would need. Safe
 * to re-run: an organization with nothing left keyed by a user id (either
 * because it was never split, or because a prior run already
 * renamed/archived everything) resolves to action:'none' and is skipped.
 */
@Injectable()
export class BillingMigrationService {
  private readonly logger = new Logger(BillingMigrationService.name);

  constructor(
    @InjectModel(Wallet.name) private walletModel: Model<WalletDocument>,
    @InjectModel(WalletTransaction.name) private transactionModel: Model<WalletTransactionDocument>,
    @InjectModel(CreditReservation.name) private reservationModel: Model<CreditReservationDocument>,
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    @InjectModel(PaymentMethod.name) private paymentMethodModel: Model<PaymentMethodDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Organization.name) private orgModel: Model<OrganizationDocument>,
  ) {}

  async run(opts: { dryRun: boolean; organizationId?: string }): Promise<MigrationRunResult> {
    const orgs = opts.organizationId
      ? await this.orgModel.find({ _id: opts.organizationId }).exec()
      : await this.orgModel.find().exec();

    const results: OrganizationMigrationPlan[] = [];
    for (const org of orgs) {
      const organizationId = org._id.toString();
      const plan = await this.planForOrganization(organizationId);
      results.push(plan);
      if (!opts.dryRun && plan.action !== 'none') {
        this.logger.log(`Applying ${plan.action} for organization ${organizationId} (${plan.sourceWallets.length} wallet(s))`);
        await this.applyPlan(plan);
      }
    }
    return { dryRun: opts.dryRun, organizations: results };
  }

  /** Read-only — computes what would happen for one organization, never
   * writes. Wallets already archived by a prior run (organizationId
   * rewritten to `migrated:<id>`) or already renamed onto the real org id
   * are never matched here, which is what makes a re-run a no-op. */
  private async planForOrganization(organizationId: string): Promise<OrganizationMigrationPlan> {
    const users = await this.userModel.find({ organizationId }).exec();
    const userIds = users.map((u) => u._id.toString());
    if (userIds.length === 0) return { organizationId, action: 'none', sourceWallets: [] };

    const wallets = await this.walletModel.find({ organizationId: { $in: userIds } }).exec();
    if (wallets.length === 0) return { organizationId, action: 'none', sourceWallets: [] };

    const sourceWallets: WalletMergeSourceSummary[] = wallets.map((w) => ({
      walletId: w._id.toString(),
      originalKey: w.organizationId,
      balanceCredits: w.balanceCredits,
      reservedCredits: w.reservedCredits,
    }));

    if (wallets.length === 1) {
      return { organizationId, action: 'rename', sourceWallets, targetWalletId: wallets[0]._id.toString() };
    }

    // Merge target: the 'owner'-role user's wallet if one exists, else the
    // oldest wallet by creation time.
    const ownerUser = users.find((u) => u.roles?.includes('owner'));
    const ownerWallet = ownerUser ? wallets.find((w) => w.organizationId === ownerUser._id.toString()) : undefined;
    const target = ownerWallet ?? [...wallets].sort((a, b) => this.createdAt(a).getTime() - this.createdAt(b).getTime())[0];

    return {
      organizationId,
      action: 'merge',
      sourceWallets,
      targetWalletId: target._id.toString(),
      mergedBalanceCredits: sourceWallets.reduce((sum, s) => sum + s.balanceCredits, 0),
      mergedReservedCredits: sourceWallets.reduce((sum, s) => sum + s.reservedCredits, 0),
    };
  }

  private async applyPlan(plan: OrganizationMigrationPlan): Promise<void> {
    if (plan.action === 'rename') {
      await this.walletModel.updateOne({ _id: plan.targetWalletId }, { $set: { organizationId: plan.organizationId } });
      return;
    }
    if (plan.action === 'merge') {
      await this.mergeWallets(plan);
    }
  }

  private async mergeWallets(plan: OrganizationMigrationPlan): Promise<void> {
    const targetId = plan.targetWalletId as string;
    const sources = plan.sourceWallets.filter((s) => s.walletId !== targetId);
    const balanceToAdd = sources.reduce((sum, s) => sum + s.balanceCredits, 0);
    const reservedToAdd = sources.reduce((sum, s) => sum + s.reservedCredits, 0);

    // 1. Repoint every dependent row from EVERY original user-key onto the
    // real org id (+ the target wallet id, for the collections that carry
    // one) — including the target wallet's own original key, not just the
    // non-target sources. The target wallet document itself is handled
    // separately in step 2; everything hanging off any of the merged
    // user-keyed identities still needs moving here regardless of which one
    // happened to become the target. Plain updateMany — no unique-index
    // collisions possible on any of these four collections.
    const allOriginalKeys = plan.sourceWallets.map((s) => s.originalKey);
    await this.reservationModel.updateMany(
      { organizationId: { $in: allOriginalKeys } },
      { $set: { organizationId: plan.organizationId, walletId: targetId } },
    );
    await this.transactionModel.updateMany(
      { organizationId: { $in: allOriginalKeys } },
      { $set: { organizationId: plan.organizationId, walletId: targetId } },
    );
    await this.paymentRecordModel.updateMany(
      { organizationId: { $in: allOriginalKeys } },
      { $set: { organizationId: plan.organizationId, walletId: targetId } },
    );
    await this.paymentMethodModel.updateMany(
      { organizationId: { $in: allOriginalKeys } },
      { $set: { organizationId: plan.organizationId, isDefault: false } },
    );

    // 2. Bump the target wallet itself onto the real org id + merged
    // balances.
    await this.walletModel.updateOne(
      { _id: targetId },
      { $set: { organizationId: plan.organizationId }, $inc: { balanceCredits: balanceToAdd, reservedCredits: reservedToAdd } },
    );

    // 3. Collapse isDefault to exactly one payment method (the
    // most-recently-created one), now that methods from every source wallet
    // share the same organizationId.
    const methods = await this.paymentMethodModel.find({ organizationId: plan.organizationId }).sort({ createdAt: -1 }).exec();
    if (methods.length > 0) {
      await this.paymentMethodModel.updateMany({ _id: { $in: methods.map((m) => m._id) } }, { $set: { isDefault: false } });
      await this.paymentMethodModel.updateOne({ _id: methods[0]._id }, { $set: { isDefault: true } });
    }

    // 4. Archive every source wallet — never deleted, keeps
    // Wallet.organizationId's unique index satisfied and preserves a
    // durable audit trail.
    const now = new Date();
    for (const source of sources) {
      await this.walletModel.updateOne(
        { _id: source.walletId },
        { $set: { organizationId: `migrated:${source.originalKey}`, migratedAt: now, migratedIntoOrganizationId: plan.organizationId } },
      );
    }

    // 5. One auditable, zero-amount ledger row on the target documenting the
    // merge — reuses the existing ledger rather than a new "migration log"
    // collection.
    const updatedTarget = await this.walletModel.findById(targetId).exec();
    await this.transactionModel.create({
      organizationId: plan.organizationId,
      walletId: targetId,
      type: 'MANUAL_ADJUSTMENT',
      amountCredits: 0,
      balanceAfterCredits: updatedTarget?.balanceCredits ?? 0,
      metadata: {
        migration: true,
        sourceWalletIds: sources.map((s) => s.walletId),
        mergedBalanceCredits: balanceToAdd,
        mergedReservedCredits: reservedToAdd,
      },
      createdBy: 'system',
    });
  }

  private createdAt(doc: WalletDocument): Date {
    return (doc as unknown as { createdAt: Date }).createdAt;
  }
}
