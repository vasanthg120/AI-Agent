import { ConfigModule } from '@nestjs/config';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AdminAccount, AdminAccountDocument, AdminAccountSchema } from '../auth/schemas/admin-account.schema';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { PricingService } from '../billing/pricing.service';
import { BillingSettings, BillingSettingsSchema } from '../billing/schemas/billing-settings.schema';
import { EncryptionService } from '../common/encryption/encryption.service';
import { IntegrationCredential, IntegrationCredentialSchema } from '../integrations/schemas/integration-credential.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { WalletTransaction, WalletTransactionSchema } from '../billing/schemas/wallet-transaction.schema';
import { MailService } from '../mail/mail.service';
import { AiUsageHierarchyService } from '../ai-usage/ai-usage-hierarchy.service';
import { AnthropicFinanceAdapter } from './adapters/anthropic-finance-adapter.service';
import { GroqFinanceAdapter } from './adapters/groq-finance-adapter.service';
import { ProviderFinanceAdapterRegistry } from './adapters/provider-finance-adapter.registry';
import { ProviderAlertService } from './provider-alert.service';
import { ProviderFinanceService } from './provider-finance.service';
import { ProviderAccount, ProviderAccountDocument, ProviderAccountSchema } from './schemas/provider-account.schema';
import { ProviderAlertLog, ProviderAlertLogDocument, ProviderAlertLogSchema } from './schemas/provider-alert-log.schema';
import { ProviderPayment, ProviderPaymentSchema } from './schemas/provider-payment.schema';

const PREFIX = `jest-provider-alert-${Date.now()}`;

describe('ProviderAlertService (real Mongo, stubbed email)', () => {
  let connection: Connection;
  let alertService: ProviderAlertService;
  let financeService: ProviderFinanceService;
  let accountModel: Model<ProviderAccountDocument>;
  let executionModel: Model<AgentExecutionDocument>;
  let adminModel: Model<AdminAccountDocument>;
  let alertLogModel: Model<ProviderAlertLogDocument>;
  const sendNotificationEmail = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: ProviderAccount.name, schema: ProviderAccountSchema },
          { name: ProviderPayment.name, schema: ProviderPaymentSchema },
          { name: ProviderAlertLog.name, schema: ProviderAlertLogSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: User.name, schema: UserSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: AdminAccount.name, schema: AdminAccountSchema },
          { name: IntegrationCredential.name, schema: IntegrationCredentialSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
        ]),
      ],
      providers: [
        ProviderAlertService,
        ProviderFinanceService,
        AiUsageHierarchyService,
        ProviderFinanceAdapterRegistry,
        PricingService,
        { provide: AnthropicFinanceAdapter, useValue: new AnthropicFinanceAdapter({} as never) },
        { provide: GroqFinanceAdapter, useValue: new GroqFinanceAdapter() },
        { provide: EncryptionService, useValue: new EncryptionService({ get: () => `${PREFIX}-key-at-least-32-bytes-long!!` } as never) },
        { provide: MailService, useValue: { sendNotificationEmail } },
      ],
    }).compile();

    alertService = moduleRef.get(ProviderAlertService);
    financeService = moduleRef.get(ProviderFinanceService);
    accountModel = moduleRef.get(getModelToken(ProviderAccount.name));
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    adminModel = moduleRef.get(getModelToken(AdminAccount.name));
    alertLogModel = moduleRef.get(getModelToken(ProviderAlertLog.name));
    connection = moduleRef.get(getConnectionToken());
  });

  afterEach(async () => {
    sendNotificationEmail.mockClear();
    await accountModel.deleteMany({});
    await executionModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await adminModel.deleteMany({ email: { $regex: `^${PREFIX}` } });
    await alertLogModel.deleteMany({});
  });

  afterAll(async () => {
    await connection.close();
  });

  // checkOneProvider/checkExhaustionTransition/checkBudgetPace are private —
  // same reflection-based access this session's other alert specs already
  // use, since the public @Cron methods iterate every tracked provider and
  // this suite needs one provider in isolation per test.
  type PrivateAlertMethods = {
    checkOneProvider(p: string): Promise<void>;
    checkExhaustionTransition(doc: ProviderAccountDocument): Promise<void>;
    checkBudgetPace(doc: ProviderAccountDocument): Promise<void>;
    checkCostVariance(doc: ProviderAccountDocument): Promise<void>;
    checkUsageCostSyncHealth(doc: ProviderAccountDocument): Promise<void>;
  };
  function priv(): PrivateAlertMethods {
    return alertService as unknown as PrivateAlertMethods;
  }

  async function freshDoc(provider: string): Promise<ProviderAccountDocument> {
    const doc = await accountModel.findOne({ provider }).exec();
    if (!doc) throw new Error(`No account doc for ${provider}`);
    return doc;
  }

  it('a status change to exhausted (as python-agent writes it) sends exactly one alert, then dedups', async () => {
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { status: 'exhausted', alertRecipients: ['test-alerts@example.com'] } }, { upsert: true }).exec();
    await priv().checkExhaustionTransition(await freshDoc('anthropic'));
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][0]).toBe('test-alerts@example.com');
    expect(sendNotificationEmail.mock.calls[0][1]).toMatch(/confirmed exhausted/i);

    sendNotificationEmail.mockClear();
    await priv().checkExhaustionTransition(await freshDoc('anthropic'));
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('recovering from exhausted sends exactly one recovery alert', async () => {
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { status: 'exhausted', alertRecipients: ['test-alerts@example.com'] } }, { upsert: true }).exec();
    await priv().checkExhaustionTransition(await freshDoc('anthropic'));
    sendNotificationEmail.mockClear();

    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { status: 'active' } }).exec();
    await priv().checkExhaustionTransition(await freshDoc('anthropic'));
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][1]).toMatch(/recovered/i);
  });

  it('crossing the 50% budget-pace tier alerts once, then dedups on the next tick', async () => {
    await financeService.upsertAccount('anthropic', { monthlyBudget: 100, alertRecipients: ['test-alerts@example.com'] });
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

    await priv().checkBudgetPace(await freshDoc('anthropic'));
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    const doc1 = await freshDoc('anthropic');
    expect(doc1.lastAlertedBudgetPct).toBe(50);

    sendNotificationEmail.mockClear();
    await priv().checkBudgetPace(await freshDoc('anthropic'));
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('draining further to the 80% tier sends a new alert (never silenced by the earlier dedup)', async () => {
    await financeService.upsertAccount('anthropic', { monthlyBudget: 100, alertRecipients: ['test-alerts@example.com'] });
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
    await priv().checkBudgetPace(await freshDoc('anthropic')); // tier 50
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
      costUsd: 25,
      success: true,
      occurredAt: new Date(),
    });
    await priv().checkBudgetPace(await freshDoc('anthropic')); // now 85% -> tier 80
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    const doc = await freshDoc('anthropic');
    expect(doc.lastAlertedBudgetPct).toBe(80);
  });

  it('raising the monthly budget back above the alerted tier sends a recovery alert and clears the dedup state', async () => {
    await financeService.upsertAccount('anthropic', { monthlyBudget: 100, alertRecipients: ['test-alerts@example.com'] });
    await executionModel.create({
      organizationId: `${PREFIX}-org3`,
      userId: `${PREFIX}-user3`,
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
    await priv().checkBudgetPace(await freshDoc('anthropic'));
    let doc = await freshDoc('anthropic');
    expect(doc.lastAlertedBudgetPct).not.toBeNull();
    sendNotificationEmail.mockClear();

    await financeService.upsertAccount('anthropic', { monthlyBudget: 1000 }); // 60/1000 = 6% — back under every tier.
    await priv().checkBudgetPace(await freshDoc('anthropic'));
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][1]).toMatch(/back under budget pace/i);
    doc = await freshDoc('anthropic');
    expect(doc.lastAlertedBudgetPct).toBeNull();
  });

  it('a cost-variance beyond threshold alerts, logging to ProviderAlertLog', async () => {
    await financeService.upsertAccount('anthropic', { alertRecipients: ['test-alerts@example.com'] });
    await executionModel.create({
      organizationId: `${PREFIX}-org4`,
      userId: `${PREFIX}-user4`,
      kind: 'llm',
      name: 'planner',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 100,
      success: true,
      occurredAt: new Date(),
    });
    // Simulates a completed usage-cost sync reporting a figure that diverges
    // from Haive's own tracked cost by more than the alert threshold.
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { lastProviderReportedCostThisMonth: 140 } }).exec();

    await priv().checkCostVariance(await freshDoc('anthropic'));
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][1]).toMatch(/differs from/i);
    const logs = await alertLogModel.find({ alertType: 'cost_variance' }).exec();
    expect(logs).toHaveLength(1);
  });

  it('usage-cost sync failure alerts once, then dedups until it either recovers or keeps failing', async () => {
    await financeService.setAdminApiKey('anthropic', 'sk-ant-admin-fake-key-for-test');
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { alertRecipients: ['test-alerts@example.com'], lastUsageCostSyncError: 'simulated failure', lastUsageCostSyncAttemptedAt: new Date() } }).exec();

    await priv().checkUsageCostSyncHealth(await freshDoc('anthropic'));
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][1]).toMatch(/sync failing/i);

    sendNotificationEmail.mockClear();
    await priv().checkUsageCostSyncHealth(await freshDoc('anthropic')); // still failing, same state -> no duplicate alert.
    expect(sendNotificationEmail).not.toHaveBeenCalled();

    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { lastUsageCostSyncError: null, lastUsageCostSyncAt: new Date() } }).exec();
    await priv().checkUsageCostSyncHealth(await freshDoc('anthropic')); // recovered -> exactly one recovery alert.
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][1]).toMatch(/sync recovered/i);
  });

  it('notifyPaymentRecorded sends a payment-recorded alert for an existing account', async () => {
    await financeService.upsertAccount('groq', { alertRecipients: ['test-alerts@example.com'] });
    await alertService.notifyPaymentRecorded('groq', 42, 'USD');
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendNotificationEmail.mock.calls[0][1]).toMatch(/payment recorded/i);
  });

  it('empty alertRecipients falls back to every active platform admin', async () => {
    await adminModel.create({ email: `${PREFIX}-admin1@example.com`, passwordHash: 'x', name: 'A', active: true });
    await adminModel.create({ email: `${PREFIX}-admin2@example.com`, passwordHash: 'x', name: 'B', active: false }); // inactive — must be excluded
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { status: 'exhausted' } }, { upsert: true }).exec();

    await priv().checkExhaustionTransition(await freshDoc('anthropic'));
    const recipientEmails = sendNotificationEmail.mock.calls.map((c) => c[0]);
    expect(recipientEmails).toContain(`${PREFIX}-admin1@example.com`);
    expect(recipientEmails).not.toContain(`${PREFIX}-admin2@example.com`);
  });
});
