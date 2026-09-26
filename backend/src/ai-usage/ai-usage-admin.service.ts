import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AgentExecution, AgentExecutionDocument } from '../command-center/schemas/agent-execution.schema';
import { IntegrationCredential, IntegrationCredentialDocument } from '../integrations/schemas/integration-credential.schema';
import { Organization, OrganizationDocument } from '../organizations/schemas/organization.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { SetAnthropicBudgetDto } from './dto/set-anthropic-budget.dto';

const PROVIDER = 'anthropic';
// Same fixed scope admin-integrations.controller.ts uses for the Anthropic
// credential itself — not a real customer organization, just the row that
// holds the platform-wide API key/budget. Never used to filter
// agent_executions (those rows carry the REAL customer organizationId that
// made each request against this shared key).
const PLATFORM_SCOPE = 'platform';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// agent_executions.organizationId/userId are plain strings written by
// python-agent (see execution_store.py) — not every historical value is
// guaranteed to be a real Mongo ObjectId (synthetic/system-context ids have
// shown up in this collection before), and Mongoose's ObjectId cast throws
// on anything else. Filtering to valid ids before querying Organization/User
// means an odd id just falls back to showing the raw id, never a 500.
function validObjectIds(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id && Types.ObjectId.isValid(id)))];
}

export interface RequestHistoryFilters {
  days: number;
  page: number;
  pageSize: number;
  model?: string;
  organizationId?: string;
  status?: 'success' | 'failed';
  search?: string;
}

// Platform-wide Anthropic usage/cost reporting for the Admin console, built
// entirely on top of the existing agent_executions collection (python-agent's
// per-call token/cost trace — see command-center/schemas/agent-execution.schema.ts's
// own comments) plus the existing IntegrationCredential row for
// connection status and admin-configured budget. No new collection.
//
// Reconciliation against Anthropic's own Usage/Cost Admin API is
// deliberately NOT implemented: that API requires a separate "Admin API
// key" credential type Anthropic issues at the organization-settings level,
// distinct from the regular API key this app stores per
// IntegrationCredential — there is no existing mechanism in this codebase to
// obtain or store one. Rather than guess at an integration this app has no
// credential for, every summary response reports
// `sync.providerReconciliationAvailable: false` so the UI can show the
// "provider-level reconciliation unavailable" state the spec calls for,
// while still showing Haive's own accurately-recorded usage.
@Injectable()
export class AiUsageAdminService {
  constructor(
    @InjectModel(AgentExecution.name) private executionModel: Model<AgentExecutionDocument>,
    @InjectModel(IntegrationCredential.name) private credentialModel: Model<IntegrationCredentialDocument>,
    @InjectModel(Organization.name) private orgModel: Model<OrganizationDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  private since(days: number): Date {
    return new Date(Date.now() - days * 86_400_000);
  }

  private baseMatch(days: number): Record<string, unknown> {
    return { provider: PROVIDER, kind: 'llm', occurredAt: { $gte: this.since(days) } };
  }

  async getSummary(days: number) {
    const match = this.baseMatch(days);
    const [totalsRows, lastRow, credential] = await Promise.all([
      this.executionModel
        .aggregate<{
          totalCalls: number;
          successfulCalls: number;
          failedCalls: number;
          inputTokens: number;
          outputTokens: number;
          cacheCreationInputTokens: number;
          cacheReadInputTokens: number;
          cost: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: null,
              totalCalls: { $sum: 1 },
              successfulCalls: { $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] } },
              failedCalls: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              cacheCreationInputTokens: { $sum: { $ifNull: ['$cacheCreationInputTokens', 0] } },
              cacheReadInputTokens: { $sum: { $ifNull: ['$cacheReadInputTokens', 0] } },
              cost: { $sum: { $ifNull: ['$costUsd', 0] } },
            },
          },
        ])
        .exec(),
      this.executionModel
        .findOne({ provider: PROVIDER, kind: 'llm' })
        .sort({ occurredAt: -1 })
        .select({ occurredAt: 1 })
        .exec(),
      this.credentialModel.findOne({ organizationId: PLATFORM_SCOPE, provider: PROVIDER }).exec(),
    ]);

    const t = totalsRows[0] ?? {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cost: 0,
    };

    const budgetUsd = credential?.budgetUsd ?? null;
    // "Haive configured budget" vs Anthropic's own account balance — see
    // integration-credential.schema.ts's budgetUsd comment. Never claimed as
    // provider truth.
    const remaining = budgetUsd != null ? Math.max(budgetUsd - t.cost, 0) : null;
    const percentage = budgetUsd != null && budgetUsd > 0 ? Math.min((t.cost / budgetUsd) * 100, 999) : null;

    return {
      provider: PROVIDER,
      connected: !!credential,
      budget: budgetUsd != null ? { amount: budgetUsd, period: credential?.budgetPeriod ?? 'monthly', currency: 'USD' } : null,
      usage: {
        cost: round2(t.cost),
        remaining: remaining != null ? round2(remaining) : null,
        percentage: percentage != null ? Math.round(percentage * 10) / 10 : null,
      },
      tokens: {
        input: t.inputTokens,
        output: t.outputTokens,
        cacheCreation: t.cacheCreationInputTokens,
        cacheRead: t.cacheReadInputTokens,
        // Deliberately input + output only, matching Anthropic's own
        // definition and agent-execution.schema.ts's totalTokens — cache
        // tokens are reported separately and never re-added here (see
        // python-agent/app/observability/cost.py's docstring on
        // double-counting).
        total: t.inputTokens + t.outputTokens,
      },
      requests: { total: t.totalCalls, successful: t.successfulCalls, failed: t.failedCalls },
      sync: {
        lastSyncedAt: lastRow?.occurredAt ?? null,
        providerReconciliationAvailable: false,
      },
      days,
    };
  }

  async getTimeseries(days: number) {
    const rows = await this.executionModel
      .aggregate<{ _id: string; cost: number; inputTokens: number; outputTokens: number; count: number }>([
        { $match: this.baseMatch(days) },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } },
            cost: { $sum: { $ifNull: ['$costUsd', 0] } },
            inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();

    return rows.map((r) => ({
      date: r._id,
      cost: round2(r.cost),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      requests: r.count,
    }));
  }

  async getModelBreakdown(days: number) {
    const rows = await this.executionModel
      .aggregate<{ _id: string; requests: number; inputTokens: number; outputTokens: number; cost: number }>([
        { $match: this.baseMatch(days) },
        {
          $group: {
            _id: { $ifNull: ['$model', 'unknown'] },
            requests: { $sum: 1 },
            inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            cost: { $sum: { $ifNull: ['$costUsd', 0] } },
          },
        },
        { $sort: { cost: -1 } },
      ])
      .exec();

    return rows.map((r) => ({
      model: r._id,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cost: round2(r.cost),
    }));
  }

  async getOrganizationBreakdown(days: number) {
    const rows = await this.executionModel
      .aggregate<{ _id: string | null; requests: number; inputTokens: number; outputTokens: number; cost: number }>([
        { $match: this.baseMatch(days) },
        {
          $group: {
            _id: '$organizationId',
            requests: { $sum: 1 },
            inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            cost: { $sum: { $ifNull: ['$costUsd', 0] } },
          },
        },
        { $sort: { cost: -1 } },
      ])
      .exec();

    // Same "batch id list -> Map<id,name>" pattern billing-admin.service.ts
    // already uses for wallets — not a new lookup service.
    const orgIds = validObjectIds(rows.map((r) => r._id));
    const orgs = await this.orgModel.find({ _id: { $in: orgIds } }, { name: 1 }).exec();
    const nameById = new Map<string, string>(orgs.map((o) => [o._id.toString(), o.name]));

    return rows.map((r) => ({
      organizationId: r._id ?? 'unknown',
      organizationName: r._id ? (nameById.get(r._id) ?? r._id) : 'Unknown',
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cost: round2(r.cost),
    }));
  }

  async getRequestHistory(filters: RequestHistoryFilters) {
    const match: Record<string, unknown> = this.baseMatch(filters.days);
    if (filters.model) match.model = filters.model;
    if (filters.organizationId) match.organizationId = filters.organizationId;
    if (filters.status === 'success') match.success = true;
    if (filters.status === 'failed') match.success = false;
    if (filters.search) {
      // Never searches prompt/response content (none is stored in this
      // collection) — only identifiers, matching the spec's "do not expose
      // prompts or private message content".
      match.$or = [
        { requestId: { $regex: filters.search, $options: 'i' } },
        { organizationId: { $regex: filters.search, $options: 'i' } },
      ];
    }

    const skip = (filters.page - 1) * filters.pageSize;
    const [rows, total] = await Promise.all([
      this.executionModel.find(match).sort({ occurredAt: -1 }).skip(skip).limit(filters.pageSize).exec(),
      this.executionModel.countDocuments(match).exec(),
    ]);

    const orgIds = validObjectIds(rows.map((r) => r.organizationId));
    const userIds = validObjectIds(rows.map((r) => r.userId));
    // {$in: []} is a valid, cheap Mongo query that just matches nothing — no
    // need for a ternary that only muddies the array element type.
    const [orgs, users] = await Promise.all([
      this.orgModel.find({ _id: { $in: orgIds } }, { name: 1 }).exec(),
      this.userModel.find({ _id: { $in: userIds } }, { name: 1, email: 1 }).exec(),
    ]);
    const orgNameById = new Map<string, string>(orgs.map((o) => [o._id.toString(), o.name]));
    const userNameById = new Map<string, string>(users.map((u) => [u._id.toString(), u.name || u.email]));

    return {
      items: rows.map((r) => ({
        id: r._id.toString(),
        occurredAt: r.occurredAt,
        organizationId: r.organizationId ?? null,
        organizationName: r.organizationId ? (orgNameById.get(r.organizationId) ?? r.organizationId) : null,
        userId: r.userId ?? null,
        userName: r.userId ? (userNameById.get(r.userId) ?? r.userId) : null,
        model: r.model ?? 'unknown',
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        totalTokens: r.totalTokens ?? 0,
        cost: r.costUsd ?? null,
        status: r.success ? 'success' : 'failed',
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async setBudget(dto: SetAnthropicBudgetDto) {
    const updated = await this.credentialModel
      .findOneAndUpdate(
        { organizationId: PLATFORM_SCOPE, provider: PROVIDER },
        { budgetUsd: dto.budgetUsd, budgetPeriod: dto.budgetPeriod ?? 'monthly' },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException('Anthropic is not connected yet — connect it in AI Providers before setting a budget.');
    }
    return { budgetUsd: updated.budgetUsd, budgetPeriod: updated.budgetPeriod };
  }
}
