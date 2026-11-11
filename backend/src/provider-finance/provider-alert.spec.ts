import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AdminAccount, AdminAccountDocument, AdminAccountSchema } from '../auth/schemas/admin-account.schema';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { WalletTransaction, WalletTransactionSchema } from '../billing/schemas/wallet-transaction.schema';
import { MailService } from '../mail/mail.service';
import { AiUsageHierarchyService } from '../ai-usage/ai-usage-hierarchy.service';
import { ProviderAlertService } from './provider-alert.service';
import { ProviderFinanceService } from './provider-finance.service';
import { ProviderAccount, ProviderAccountDocument, ProviderAccountSchema } from './schemas/provider-account.schema';
import { ProviderPayment, ProviderPaymentSchema } from './schemas/provider-payment.schema';

const PREFIX = `jest-provider-alert-${Date.now()}`;

describe('ProviderAlertService (real Mongo, stubbed email)', () => {
  let connection: Connection;
  let alertService: ProviderAlertService;
  let financeService: ProviderFinanceService;
  let accountModel: Model<ProviderAccountDocument>;
  let executionModel: Model<AgentExecutionDocument>;
  let adminModel: Model<AdminAccountDocument>;
  const sendNotificationEmail = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: ProviderAccount.name, schema: ProviderAccountSchema },
          { name: ProviderPayment.name, schema: ProviderPaymentSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: User.name, schema: UserSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: AdminAccount.name, schema: AdminAccountSchema },
        ]),
      ],
      providers: [
        ProviderAlertService,
        ProviderFinanceService,
        AiUsageHierarchyService,
        { provide: MailService, useValue: { sendNotificationEmail } },
      ],
    }).compile();

    alertService = moduleRef.get(ProviderAlertService);
    financeService = moduleRef.get(ProviderFinanceService);
    accountModel = moduleRef.get(getModelToken(ProviderAccount.name));
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    adminModel = moduleRef.get(getModelToken(AdminAccount.name));
    connection = moduleRef.get(getConnectionToken());
  });

  afterEach(async () => {
    sendNotificationEmail.mockClear();
    await accountModel.deleteMany({});
    await executionModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await adminModel.deleteMany({ email: { $regex: `^${PREFIX}` } });
  });

  afterAll(async () => {
    await connection.close();
  });

  async function checkOne(provider: string) {
    // checkOneProvider is private — this is the same reflection-based
    // access this module's own live verification already used, since
    // Cron-decorated public methods iterate every tracked provider and this
    // suite needs one provider in isolation per test.
    return (alertService as unknown as { checkOneProvider(p: string): Promise<void> }).checkOneProvider(provider);
  }

  it('never alerts before any reconciliation has happened (nothing to compare against)', async () => {
    await checkOne('anthropic');
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('a healthy balance (above every threshold) sends no alert', async () => {
    await financeService.recordReconciliation('anthropic', { confirmedBalance: 100 }, 'admin-1');
    await checkOne('anthropic');
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('crossing the 50% informational threshold alerts once, then dedups on the next tick', async () => {
    await financeService.recordReconciliation('anthropic', { confirmedBalance: 100 }, 'admin-1');
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { alertRecipients: ['test-alerts@example.com'] } });
    await executionModel.create({
      organizationId: `${PREFIX}-org`,
      userId: `${PREFIX}-user`,
      kind: 'llm',
      name: 'planner',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 60,
      success: true,
      occurredAt: new Date(),
    });

    await checkOne('anthropic');
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][0]).toBe('test-alerts@example.com');
    const doc1 = await accountModel.findOne({ provider: 'anthropic' }).exec();
    expect(doc1?.lastAlertedThresholdPct).toBe(50);

    sendNotificationEmail.mockClear();
    await checkOne('anthropic');
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('draining further to a worse tier sends a new alert (never silenced by the earlier dedup)', async () => {
    await financeService.recordReconciliation('anthropic', { confirmedBalance: 100 }, 'admin-1');
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { alertRecipients: ['test-alerts@example.com'] } });
    await executionModel.create({
      organizationId: `${PREFIX}-org2`,
      userId: `${PREFIX}-user2`,
      kind: 'llm',
      name: 'planner',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 60,
      success: true,
      occurredAt: new Date(),
    });
    await checkOne('anthropic'); // tier 50
    sendNotificationEmail.mockClear();

    await executionModel.create({
      organizationId: `${PREFIX}-org2`,
      userId: `${PREFIX}-user2`,
      kind: 'llm',
      name: 'planner',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 35,
      success: true,
      occurredAt: new Date(),
    });
    await checkOne('anthropic'); // now 5% remaining -> tier 10 (critical)
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    const doc = await accountModel.findOne({ provider: 'anthropic' }).exec();
    expect(doc?.lastAlertedThresholdPct).toBe(10);
  });

  it('a reconciliation resets the alert state, so the next healthy tick stays silent', async () => {
    await financeService.recordReconciliation('anthropic', { confirmedBalance: 100 }, 'admin-1');
    await executionModel.create({
      organizationId: `${PREFIX}-org3`,
      userId: `${PREFIX}-user3`,
      kind: 'llm',
      name: 'planner',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 90,
      success: true,
      occurredAt: new Date(),
    });
    await checkOne('anthropic');
    let doc = await accountModel.findOne({ provider: 'anthropic' }).exec();
    expect(doc?.lastAlertedThresholdPct).not.toBeNull();

    await financeService.recordReconciliation('anthropic', { confirmedBalance: 200 }, 'admin-1');
    doc = await accountModel.findOne({ provider: 'anthropic' }).exec();
    expect(doc?.lastAlertedThresholdPct).toBeNull();
  });

  it('empty alertRecipients falls back to every active platform admin', async () => {
    await adminModel.create({ email: `${PREFIX}-admin1@example.com`, passwordHash: 'x', name: 'A', active: true });
    await adminModel.create({ email: `${PREFIX}-admin2@example.com`, passwordHash: 'x', name: 'B', active: false }); // inactive — must be excluded
    await financeService.recordReconciliation('anthropic', { confirmedBalance: 100 }, 'admin-1');
    await executionModel.create({
      organizationId: `${PREFIX}-org4`,
      userId: `${PREFIX}-user4`,
      kind: 'llm',
      name: 'planner',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 60,
      success: true,
      occurredAt: new Date(),
    });

    await checkOne('anthropic');
    const recipientEmails = sendNotificationEmail.mock.calls.map((c) => c[0]);
    expect(recipientEmails).toContain(`${PREFIX}-admin1@example.com`);
    expect(recipientEmails).not.toContain(`${PREFIX}-admin2@example.com`);
  });
});
