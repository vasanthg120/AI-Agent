import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Parser } from 'json2csv';
import { Model, Types } from 'mongoose';
import { AgentExecution, AgentExecutionDocument } from '../command-center/schemas/agent-execution.schema';
import { Organization, OrganizationDocument } from '../organizations/schemas/organization.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { WalletTransaction, WalletTransactionDocument } from '../billing/schemas/wallet-transaction.schema';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Same "not every historical value is a real Mongo ObjectId" guard
// ai-usage-admin.service.ts's own validObjectIds already uses — duplicated
// here rather than imported, matching this codebase's established "small
// helper, local to each file" convention for this exact shape of problem.
function validObjectIds(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id && Types.ObjectId.isValid(id)))];
}

export interface GetUserDetailOptions {
  page: number;
  pageSize: number;
}

// Platform -> Organisation -> User -> Request -> Generation hierarchical AI
// usage analytics — provider-agnostic (every provider agent_executions ever
// records, not just Anthropic; see ai-usage-admin.service.ts's own
// PROVIDER-scoped baseMatch for why that one stays separate and untouched).
//
// Every method here is a pure read against agent_executions/
// wallet_transactions/organizations/users — nothing here ever writes to any
// collection, and "customer charge" figures are always read directly from
// WalletTransaction (type: 'AI_USAGE'), never recomputed from agent_executions'
// own costUsd (that's provider cost, a different number — see
// agent-execution.schema.ts's own doc comment on why the two are kept
// separate). Every multi-row sum groups by requestId exactly the way
// billing/reservation.service.ts's own settle() already does, so these
// figures can never drift from what billing actually charged.
@Injectable()
export class AiUsageHierarchyService {
  constructor(
    @InjectModel(AgentExecution.name) private executionModel: Model<AgentExecutionDocument>,
    @InjectModel(Organization.name) private orgModel: Model<OrganizationDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(WalletTransaction.name) private transactionModel: Model<WalletTransactionDocument>,
  ) {}

  private since(days: number): Date {
    return new Date(Date.now() - days * 86_400_000);
  }

  // Single source of truth for "how much has this provider genuinely cost
  // since a given moment" — used by provider-finance.service.ts's
  // consumption-this-month / budget-pace math so that figure can never
  // diverge from what this dashboard itself reports for the same
  // provider/window. kind:'llm' only, same reasoning as every other cost
  // sum in this file — a tool span carries no cost.
  async getProviderCostSince(provider: string, since: Date): Promise<number> {
    const rows = await this.executionModel
      .aggregate<{ cost: number }>([
        { $match: { kind: 'llm', provider, occurredAt: { $gte: since } } },
        { $group: { _id: null, cost: { $sum: { $ifNull: ['$costUsd', 0] } } } },
      ])
      .exec();
    return round2(rows[0]?.cost ?? 0);
  }

  // Provider-agnostic — no `provider` filter, unlike
  // ai-usage-admin.service.ts's Anthropic-only baseMatch.
  private llmMatch(days: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { kind: 'llm', occurredAt: { $gte: this.since(days) }, ...extra };
  }

  private async customerChargeTotal(match: Record<string, unknown>): Promise<number> {
    const rows = await this.transactionModel
      .aggregate<{ total: number }>([{ $match: match }, { $group: { _id: null, total: { $sum: { $abs: '$amountCredits' } } } }])
      .exec();
    return round2(rows[0]?.total ?? 0);
  }

  async getPlatformOverview(days: number) {
    const match = this.llmMatch(days);
    const since = this.since(days);

    const [totals, providerModelRows, dailySeries, orgIds, userIds, requestIds, customerCharge] = await Promise.all([
      this.executionModel
        .aggregate<{
          inputTokens: number;
          outputTokens: number;
          cost: number;
          totalCalls: number;
          successfulCalls: number;
          failedCalls: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: null,
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              cost: { $sum: { $ifNull: ['$costUsd', 0] } },
              totalCalls: { $sum: 1 },
              successfulCalls: { $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] } },
              failedCalls: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
            },
          },
        ])
        .exec(),
      this.executionModel
        .aggregate<{ _id: { provider: string | null; model: string | null }; requests: number; inputTokens: number; outputTokens: number; cost: number }>([
          { $match: match },
          {
            $group: {
              _id: { provider: { $ifNull: ['$provider', 'unknown'] }, model: { $ifNull: ['$model', 'unknown'] } },
              requests: { $sum: 1 },
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              cost: { $sum: { $ifNull: ['$costUsd', 0] } },
            },
          },
          { $sort: { cost: -1 } },
        ])
        .exec(),
      this.executionModel
        .aggregate<{ _id: string; cost: number; requests: number }>([
          { $match: match },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } }, cost: { $sum: { $ifNull: ['$costUsd', 0] } }, requests: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      this.executionModel.distinct('organizationId', match).exec(),
      this.executionModel.distinct('userId', match).exec(),
      this.executionModel.distinct('requestId', { ...match, requestId: { $exists: true, $ne: '' } }).exec(),
      this.customerChargeTotal({ type: 'AI_USAGE', createdAt: { $gte: since } }),
    ]);

    const t = totals[0] ?? { inputTokens: 0, outputTokens: 0, cost: 0, totalCalls: 0, successfulCalls: 0, failedCalls: 0 };

    return {
      days,
      organizationCount: orgIds.filter(Boolean).length,
      activeUserCount: userIds.filter(Boolean).length,
      requestCount: requestIds.length,
      // Always derived from input+output, never the stored totalTokens field
      // — that field is only reliably populated on rows python-agent wrote
      // after it existed (see agent-execution.schema.ts's own comment),
      // so summing it directly under-counts against a mixed-age dataset.
      // Matches ai-usage-admin.service.ts's own getSummary(), which never
      // reads totalTokens for this exact reason.
      tokens: { input: t.inputTokens, output: t.outputTokens, total: t.inputTokens + t.outputTokens },
      providerCostUsd: round2(t.cost),
      customerChargeCredits: customerCharge,
      requests: { total: t.totalCalls, successful: t.successfulCalls, failed: t.failedCalls },
      providerModelBreakdown: providerModelRows.map((r) => ({
        provider: r._id.provider,
        model: r._id.model,
        requests: r.requests,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost: round2(r.cost),
      })),
      dailySeries: dailySeries.map((r) => ({ date: r._id, cost: round2(r.cost), requests: r.requests })),
    };
  }

  async getOrganizationsList(days: number, search?: string) {
    const match = this.llmMatch(days);
    const rows = await this.executionModel
      .aggregate<{ _id: string | null; requestIds: (string | null)[]; userIds: (string | null)[]; inputTokens: number; outputTokens: number; cost: number }>([
        { $match: match },
        {
          $group: {
            _id: '$organizationId',
            requestIds: { $addToSet: '$requestId' },
            userIds: { $addToSet: '$userId' },
            inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            cost: { $sum: { $ifNull: ['$costUsd', 0] } },
          },
        },
      ])
      .exec();

    const orgIds = validObjectIds(rows.map((r) => r._id));
    const [orgs, chargeRows] = await Promise.all([
      this.orgModel.find({ _id: { $in: orgIds } }, { name: 1, status: 1, createdAt: 1 }).exec(),
      this.transactionModel
        .aggregate<{ _id: string; total: number }>([
          { $match: { type: 'AI_USAGE', createdAt: { $gte: this.since(days) }, organizationId: { $in: rows.map((r) => r._id).filter(Boolean) as string[] } } },
          { $group: { _id: '$organizationId', total: { $sum: { $abs: '$amountCredits' } } } },
        ])
        .exec(),
    ]);
    const orgById = new Map(orgs.map((o) => [o._id.toString(), o]));
    const chargeByOrg = new Map(chargeRows.map((r) => [r._id, r.total]));

    const items = rows.map((r) => {
      const org = r._id ? orgById.get(r._id) : undefined;
      return {
        organizationId: r._id ?? 'unknown',
        organizationName: org?.name ?? r._id ?? 'Unknown',
        status: org?.status ?? null,
        createdAt: (org as { createdAt?: Date } | undefined)?.createdAt ?? null,
        requests: r.requestIds.filter((id): id is string => !!id).length,
        activeUsers: r.userIds.filter(Boolean).length,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        providerCostUsd: round2(r.cost),
        customerChargeCredits: round2(chargeByOrg.get(r._id ?? '') ?? 0),
      };
    });

    const filtered = search ? items.filter((i) => i.organizationName.toLowerCase().includes(search.toLowerCase())) : items;
    return filtered.sort((a, b) => b.providerCostUsd - a.providerCostUsd);
  }

  async getOrganizationDetail(organizationId: string, days: number) {
    const match = this.llmMatch(days, { organizationId });
    const [totals, userRows, org, customerCharge] = await Promise.all([
      this.executionModel
        .aggregate<{ requestIds: (string | null)[]; inputTokens: number; outputTokens: number; cost: number; totalCalls: number }>([
          { $match: match },
          {
            $group: {
              _id: null,
              requestIds: { $addToSet: '$requestId' },
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              cost: { $sum: { $ifNull: ['$costUsd', 0] } },
              totalCalls: { $sum: 1 },
            },
          },
        ])
        .exec(),
      this.executionModel
        .aggregate<{ _id: string | null; requestIds: (string | null)[]; inputTokens: number; outputTokens: number; cost: number; lastActivity: Date }>([
          { $match: match },
          {
            $group: {
              _id: '$userId',
              requestIds: { $addToSet: '$requestId' },
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              cost: { $sum: { $ifNull: ['$costUsd', 0] } },
              lastActivity: { $max: '$occurredAt' },
            },
          },
          { $sort: { cost: -1 } },
        ])
        .exec(),
      Types.ObjectId.isValid(organizationId) ? this.orgModel.findById(organizationId, { name: 1, status: 1 }).exec() : null,
      this.customerChargeTotal({ type: 'AI_USAGE', organizationId, createdAt: { $gte: this.since(days) } }),
    ]);

    const userIds = validObjectIds(userRows.map((r) => r._id));
    const users = await this.userModel.find({ _id: { $in: userIds } }, { name: 1, email: 1 }).exec();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    const t = totals[0] ?? { requestIds: [], inputTokens: 0, outputTokens: 0, cost: 0, totalCalls: 0 };

    return {
      organizationId,
      organizationName: org?.name ?? organizationId,
      status: org?.status ?? null,
      days,
      requests: t.requestIds.filter((id): id is string => !!id).length,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      providerCostUsd: round2(t.cost),
      customerChargeCredits: customerCharge,
      users: userRows.map((r) => {
        const u = r._id ? userById.get(r._id) : undefined;
        return {
          userId: r._id ?? 'unknown',
          userName: u?.name ?? r._id ?? 'Unknown',
          email: u?.email ?? null,
          requests: r.requestIds.filter((id): id is string => !!id).length,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          providerCostUsd: round2(r.cost),
          lastActivity: r.lastActivity,
        };
      }),
    };
  }

  async getUserDetail(organizationId: string, userId: string, days: number, options: GetUserDetailOptions) {
    const match = this.llmMatch(days, { organizationId, userId });

    const [totals, modelRows, agentRows, lastRow, user, customerCharge] = await Promise.all([
      this.executionModel
        .aggregate<{ inputTokens: number; outputTokens: number; cost: number; totalCalls: number }>([
          { $match: match },
          {
            $group: {
              _id: null,
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              cost: { $sum: { $ifNull: ['$costUsd', 0] } },
              totalCalls: { $sum: 1 },
            },
          },
        ])
        .exec(),
      this.executionModel
        .aggregate<{ _id: string; requests: number; cost: number }>([
          { $match: match },
          { $group: { _id: { $ifNull: ['$model', 'unknown'] }, requests: { $sum: 1 }, cost: { $sum: { $ifNull: ['$costUsd', 0] } } } },
          { $sort: { cost: -1 } },
        ])
        .exec(),
      // "Agent-wise consumption" — agent_executions.name already identifies
      // which agent/specialist/tool made the call (e.g. "planner",
      // "specialist_crm", "classify") — see tracing.py's own traced_llm_call
      // callers. No separate agentName field needed; name already is one.
      this.executionModel
        .aggregate<{ _id: string; requests: number; cost: number }>([
          { $match: match },
          { $group: { _id: '$name', requests: { $sum: 1 }, cost: { $sum: { $ifNull: ['$costUsd', 0] } } } },
          { $sort: { cost: -1 } },
        ])
        .exec(),
      this.executionModel.findOne({ organizationId, userId }).sort({ occurredAt: -1 }).select({ occurredAt: 1 }).exec(),
      Types.ObjectId.isValid(userId) ? this.userModel.findById(userId, { name: 1, email: 1 }).exec() : null,
      this.customerChargeTotal({ type: 'AI_USAGE', organizationId, createdAt: { $gte: this.since(days) } }),
    ]);

    // Request list: group by distinct requestId, newest first, paginated.
    // Status is 'success' if ANY row for that requestId succeeded — a
    // Groq-fails/Claude-succeeds fallback is correctly a successful request,
    // matching how the user actually experienced it.
    const requestPipeline = [
      { $match: { ...match, requestId: { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: '$requestId',
          startedAt: { $min: '$occurredAt' },
          inputTokens: { $sum: { $cond: [{ $eq: ['$kind', 'llm'] }, { $ifNull: ['$inputTokens', 0] }, 0] } },
          outputTokens: { $sum: { $cond: [{ $eq: ['$kind', 'llm'] }, { $ifNull: ['$outputTokens', 0] }, 0] } },
          cost: { $sum: { $cond: [{ $eq: ['$kind', 'llm'] }, { $ifNull: ['$costUsd', 0] }, 0] } },
          generationCount: { $sum: { $cond: [{ $eq: ['$kind', 'llm'] }, 1, 0] } },
          anySuccess: { $max: { $cond: ['$success', 1, 0] } },
          agents: { $addToSet: '$name' },
        },
      },
      { $sort: { startedAt: -1 as const } },
    ];
    const [requestRows, requestTotal] = await Promise.all([
      this.executionModel
        .aggregate<{ _id: string; startedAt: Date; inputTokens: number; outputTokens: number; cost: number; generationCount: number; anySuccess: number; agents: string[] }>(
          [...requestPipeline, { $skip: (options.page - 1) * options.pageSize }, { $limit: options.pageSize }],
        )
        .exec(),
      this.executionModel.aggregate<{ count: number }>([...requestPipeline, { $count: 'count' }]).exec(),
    ]);

    const t = totals[0] ?? { inputTokens: 0, outputTokens: 0, cost: 0, totalCalls: 0 };

    return {
      organizationId,
      userId,
      userName: user?.name ?? userId,
      email: user?.email ?? null,
      days,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      providerCostUsd: round2(t.cost),
      customerChargeCredits: customerCharge,
      lastActivity: lastRow?.occurredAt ?? null,
      modelBreakdown: modelRows.map((r) => ({ model: r._id, requests: r.requests, cost: round2(r.cost) })),
      agentBreakdown: agentRows.map((r) => ({ agentName: r._id, requests: r.requests, cost: round2(r.cost) })),
      requests: {
        items: requestRows.map((r) => ({
          requestId: r._id,
          startedAt: r.startedAt,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          totalTokens: r.inputTokens + r.outputTokens,
          providerCostUsd: round2(r.cost),
          generationCount: r.generationCount,
          status: r.anySuccess === 1 ? 'success' : 'failed',
          agents: r.agents.filter(Boolean),
        })),
        total: requestTotal[0]?.count ?? 0,
        page: options.page,
        pageSize: options.pageSize,
      },
    };
  }

  async getRequestDetail(requestId: string) {
    const rows = await this.executionModel.find({ requestId }).sort({ occurredAt: 1 }).exec();

    // kind:'llm' only — "do not count tool spans as LLM generations".
    const llmRows = rows.filter((r) => r.kind === 'llm');
    const inputTokens = llmRows.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
    const outputTokens = llmRows.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
    const reasoningTokens = llmRows.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0);
    const providerCostUsd = llmRows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const anySuccess = rows.some((r) => r.success);

    const charge = await this.transactionModel.findOne({ type: 'AI_USAGE', 'metadata.requestId': requestId }).exec();

    return {
      requestId,
      organizationId: rows[0]?.organizationId ?? null,
      userId: rows[0]?.userId ?? null,
      conversationId: rows[0]?.conversationId ?? null,
      startedAt: rows[0]?.occurredAt ?? null,
      status: rows.length === 0 ? null : anySuccess ? 'success' : 'failed',
      summary: {
        generationCount: llmRows.length,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        reasoningTokens: reasoningTokens || null,
        providerCostUsd: round2(providerCostUsd),
        // Honestly 0 when this request was never settled (e.g. it failed
        // before billing charged anything) — never fabricated.
        customerChargeCredits: charge ? round2(Math.abs(charge.amountCredits)) : 0,
      },
      generations: rows.map((r) => ({
        id: r._id.toString(),
        kind: r.kind,
        agentName: r.name,
        provider: r.provider ?? null,
        model: r.model ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        cacheCreationInputTokens: r.cacheCreationInputTokens ?? null,
        cacheReadInputTokens: r.cacheReadInputTokens ?? null,
        reasoningTokens: r.reasoningTokens ?? null,
        totalTokens: r.totalTokens ?? null,
        costUsd: r.costUsd ?? null,
        latencyMs: r.latencyMs ?? null,
        success: r.success,
        error: r.error ?? null,
        occurredAt: r.occurredAt,
        langfuseTraceUrl: r.langfuseTraceUrl ?? null,
      })),
    };
  }

  // One export endpoint for all three list views (org list / user list
  // within an org / request list within a user), dispatched by which scope
  // ids are present — avoids a separate export route per drill-down level.
  // Same json2csv convention business-intelligence/email-analytics-export.service.ts
  // already uses. Capped at 5000 rows, same cap that export already uses.
  private static readonly EXPORT_ROW_CAP = 5000;

  async exportCsv(scope: { organizationId?: string; userId?: string }, days: number): Promise<{ csv: string; filename: string }> {
    if (scope.organizationId && scope.userId) {
      const detail = await this.getUserDetail(scope.organizationId, scope.userId, days, { page: 1, pageSize: AiUsageHierarchyService.EXPORT_ROW_CAP });
      const parser = new Parser({ fields: ['requestId', 'startedAt', 'inputTokens', 'outputTokens', 'totalTokens', 'providerCostUsd', 'generationCount', 'status', 'agents'] });
      return { csv: parser.parse(detail.requests.items), filename: `ai-usage-requests-${scope.userId}.csv` };
    }
    if (scope.organizationId) {
      const detail = await this.getOrganizationDetail(scope.organizationId, days);
      const parser = new Parser({ fields: ['userId', 'userName', 'email', 'requests', 'inputTokens', 'outputTokens', 'providerCostUsd', 'lastActivity'] });
      return { csv: parser.parse(detail.users), filename: `ai-usage-users-${scope.organizationId}.csv` };
    }
    const orgs = await this.getOrganizationsList(days);
    const parser = new Parser({
      fields: ['organizationId', 'organizationName', 'status', 'requests', 'activeUsers', 'inputTokens', 'outputTokens', 'providerCostUsd', 'customerChargeCredits'],
    });
    return { csv: parser.parse(orgs), filename: 'ai-usage-organizations.csv' };
  }
}
