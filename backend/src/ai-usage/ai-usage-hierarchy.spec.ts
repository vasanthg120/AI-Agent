import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from '../billing/schemas/wallet-transaction.schema';
import { AiUsageHierarchyService } from './ai-usage-hierarchy.service';

// Real-Mongo integration tests, same convention as
// billing-admin-metrics.spec.ts/customer-jobs.spec.ts — a unique prefix per
// run so this shared dev database's accumulated data from every other spec
// (and manual browser sessions) never collides with these assertions, which
// scope every query to this test's own organizationId values rather than
// asserting on platform-wide totals.
const PREFIX = `jest-ai-usage-hierarchy-${Date.now()}`;

describe('AiUsageHierarchyService (real Mongo)', () => {
  let connection: Connection;
  let service: AiUsageHierarchyService;
  let executionModel: Model<AgentExecutionDocument>;
  let transactionModel: Model<WalletTransactionDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: User.name, schema: UserSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
        ]),
      ],
      providers: [AiUsageHierarchyService],
    }).compile();

    service = moduleRef.get(AiUsageHierarchyService);
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await executionModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  it('scopes two organisations with multiple users independently (no cross-org leakage)', async () => {
    const orgA = `${PREFIX}-org-a`;
    const orgB = `${PREFIX}-org-b`;
    await executionModel.create([
      { organizationId: orgA, userId: `${PREFIX}-user-a1`, requestId: `${PREFIX}-req-a1`, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 10, outputTokens: 5, costUsd: 0.01, success: true, occurredAt: new Date() },
      { organizationId: orgA, userId: `${PREFIX}-user-a2`, requestId: `${PREFIX}-req-a2`, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 20, outputTokens: 10, costUsd: 0.02, success: true, occurredAt: new Date() },
      { organizationId: orgB, userId: `${PREFIX}-user-b1`, requestId: `${PREFIX}-req-b1`, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 999, outputTokens: 999, costUsd: 9.99, success: true, occurredAt: new Date() },
    ]);

    const detailA = await service.getOrganizationDetail(orgA, 1);
    expect(detailA.requests).toBe(2);
    expect(detailA.inputTokens).toBe(30);
    expect(detailA.users).toHaveLength(2);
    // Org isolation: org A's detail never includes org B's 999/999/9.99 row.
    expect(detailA.inputTokens).not.toBe(999);
    expect(detailA.providerCostUsd).toBeCloseTo(0.03, 5);
  });

  it('a single user making multiple requests is reflected correctly in getUserDetail', async () => {
    const org = `${PREFIX}-org-multi-req`;
    const user = `${PREFIX}-user-multi-req`;
    await executionModel.create([
      { organizationId: org, userId: user, requestId: `${PREFIX}-mr-1`, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 5, outputTokens: 5, costUsd: 0.001, success: true, occurredAt: new Date() },
      { organizationId: org, userId: user, requestId: `${PREFIX}-mr-2`, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 6, outputTokens: 6, costUsd: 0.002, success: true, occurredAt: new Date() },
      { organizationId: org, userId: user, requestId: `${PREFIX}-mr-3`, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 7, outputTokens: 7, costUsd: 0.003, success: true, occurredAt: new Date() },
    ]);

    const detail = await service.getUserDetail(org, user, 1, { page: 1, pageSize: 10 });
    expect(detail.requests.total).toBe(3);
    expect(detail.requests.items).toHaveLength(3);
    expect(detail.inputTokens).toBe(18);
  });

  it('a single request with multiple agent generations aggregates without double-counting, excluding tool spans', async () => {
    const org = `${PREFIX}-org-multi-agent`;
    const user = `${PREFIX}-user-multi-agent`;
    const requestId = `${PREFIX}-multi-agent-req`;
    await executionModel.create([
      { organizationId: org, userId: user, requestId, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 100, outputTokens: 50, costUsd: 0.01, success: true, occurredAt: new Date(Date.now() - 2000) },
      { organizationId: org, userId: user, requestId, kind: 'tool', name: 'crm_deal_tool', success: true, occurredAt: new Date(Date.now() - 1000) },
      { organizationId: org, userId: user, requestId, kind: 'llm', name: 'specialist_crm', provider: 'anthropic', model: 'claude-x', inputTokens: 200, outputTokens: 80, costUsd: 0.02, success: true, occurredAt: new Date() },
    ]);

    const detail = await service.getRequestDetail(requestId);
    expect(detail.generations).toHaveLength(3); // full timeline includes the tool span
    expect(detail.summary.generationCount).toBe(2); // but the LLM-generation count excludes it
    expect(detail.summary.inputTokens).toBe(300); // 100 + 200, never double-counted, tool contributes 0
    expect(detail.summary.outputTokens).toBe(130);
    expect(detail.summary.providerCostUsd).toBeCloseTo(0.03, 5);
    expect(detail.status).toBe('success');
  });

  it('a Claude<->Groq fallback (Groq fails, Claude succeeds) is reported as a successful request', async () => {
    const org = `${PREFIX}-org-fallback`;
    const user = `${PREFIX}-user-fallback`;
    const requestId = `${PREFIX}-fallback-req`;
    await executionModel.create([
      { organizationId: org, userId: user, requestId, kind: 'llm', name: 'general', provider: 'groq', model: 'groq-x', inputTokens: 10, outputTokens: 0, costUsd: 0, success: false, error: 'rate_limited', occurredAt: new Date(Date.now() - 1000) },
      { organizationId: org, userId: user, requestId, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 15, outputTokens: 8, costUsd: 0.002, success: true, occurredAt: new Date() },
    ]);

    const detail = await service.getRequestDetail(requestId);
    expect(detail.status).toBe('success');
    expect(detail.generations.some((g) => g.provider === 'groq' && g.success === false)).toBe(true);
    expect(detail.generations.some((g) => g.provider === 'anthropic' && g.success === true)).toBe(true);

    const userDetail = await service.getUserDetail(org, user, 1, { page: 1, pageSize: 10 });
    expect(userDetail.requests.items.find((r) => r.requestId === requestId)?.status).toBe('success');
  });

  it('a fully-failed request (every row failed) is reported as failed, never silently dropped', async () => {
    const org = `${PREFIX}-org-failed`;
    const user = `${PREFIX}-user-failed`;
    const requestId = `${PREFIX}-failed-req`;
    await executionModel.create([
      { organizationId: org, userId: user, requestId, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 10, outputTokens: 0, costUsd: 0, success: false, error: 'overloaded', occurredAt: new Date() },
    ]);

    const detail = await service.getRequestDetail(requestId);
    expect(detail.status).toBe('failed');
    expect(detail.summary.generationCount).toBe(1);
  });

  it('handles missing token usage gracefully (undefined inputTokens/outputTokens never throws, treated as 0)', async () => {
    const org = `${PREFIX}-org-missing-tokens`;
    const user = `${PREFIX}-user-missing-tokens`;
    const requestId = `${PREFIX}-missing-tokens-req`;
    await executionModel.create({ organizationId: org, userId: user, requestId, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', success: true, occurredAt: new Date() });

    await expect(service.getRequestDetail(requestId)).resolves.toMatchObject({ summary: { inputTokens: 0, outputTokens: 0 } });
    await expect(service.getUserDetail(org, user, 1, { page: 1, pageSize: 10 })).resolves.toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('a request never settled (no matching WalletTransaction) reports customer charge as honestly 0, never fabricated', async () => {
    const requestId = `${PREFIX}-unsettled-req`;
    await executionModel.create({ organizationId: `${PREFIX}-org-unsettled`, userId: `${PREFIX}-user-unsettled`, requestId, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 1, outputTokens: 1, costUsd: 0.0001, success: true, occurredAt: new Date() });

    const detail = await service.getRequestDetail(requestId);
    expect(detail.summary.customerChargeCredits).toBe(0);
  });

  it('a settled request reads its real customer charge from WalletTransaction, matching the signed-amount convention wallet.service.ts writes', async () => {
    const requestId = `${PREFIX}-settled-req`;
    const org = `${PREFIX}-org-settled`;
    await executionModel.create({ organizationId: org, userId: `${PREFIX}-user-settled`, requestId, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 100, outputTokens: 50, costUsd: 0.02, success: true, occurredAt: new Date() });
    await transactionModel.create({
      organizationId: org,
      walletId: 'fake-wallet',
      type: 'AI_USAGE',
      amountCredits: -42, // negative, matching wallet.service.ts's recordUsageTransaction convention
      balanceAfterCredits: 100,
      metadata: { requestId },
      createdBy: 'jest',
    });

    const detail = await service.getRequestDetail(requestId);
    expect(detail.summary.customerChargeCredits).toBe(42); // reported as a positive magnitude
  });

  it('never writes to WalletTransaction or any billing collection — every method here is read-only', async () => {
    const createSpy = jest.spyOn(transactionModel, 'create');
    const updateSpy = jest.spyOn(transactionModel, 'updateOne');
    const org = `${PREFIX}-org-readonly-check`;
    await executionModel.create({ organizationId: org, userId: `${PREFIX}-user-readonly`, requestId: `${PREFIX}-readonly-req`, kind: 'llm', name: 'planner', provider: 'anthropic', model: 'claude-x', inputTokens: 1, outputTokens: 1, costUsd: 0.0001, success: true, occurredAt: new Date() });

    await service.getPlatformOverview(1);
    await service.getOrganizationsList(1);
    await service.getOrganizationDetail(org, 1);
    await service.getUserDetail(org, `${PREFIX}-user-readonly`, 1, { page: 1, pageSize: 10 });
    await service.getRequestDetail(`${PREFIX}-readonly-req`);
    await service.exportCsv({}, 1);

    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
    updateSpy.mockRestore();
  });
});
