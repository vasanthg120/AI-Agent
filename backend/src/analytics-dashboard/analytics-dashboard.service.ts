import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CustomerActivityService } from '../crm/customer-activity.service';
import { DealPerformanceDashboardService } from '../crm/deal-performance-dashboard.service';
import { QuotesService } from '../crm/quotes.service';
import { Deal, DealDocument } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument } from '../crm/schemas/quote.schema';
import { SalesAnalyticsService } from '../crm/sales-analytics.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AiInsightItem, AnalyticsDashboardOverview, ScopeInfo } from './analytics-dashboard.types';

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Phase 19 — Unified Analytics Dashboard. A hybrid aggregator matching
// business-dashboard.service.ts's own precedent: reuse sibling services
// where a correct implementation already exists (achievement/forecast,
// consultant performance, revenue trend), inject Deal/Quote models directly
// only for the two genuinely new groupby queries (deal split, quote
// acceptance) that don't belong in any existing service.
@Injectable()
export class AnalyticsDashboardService {
  constructor(
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    private salesAnalyticsService: SalesAnalyticsService,
    private dealPerformanceDashboardService: DealPerformanceDashboardService,
    private quotesService: QuotesService,
    private customerActivityService: CustomerActivityService,
    private emailIntelligenceService: EmailIntelligenceService,
    private dashboardService: DashboardService,
    private organizationsService: OrganizationsService,
  ) {}

  // Phase 24 — the frontend's date filter is now always a single whole
  // calendar month (MonthYearFilterPopup), so every widget can honestly
  // follow dateFrom's own month instead of being locked to "now" — the old
  // "can't fabricate a pro-rated number for an arbitrary range" constraint
  // no longer applies once the range itself is always exactly one month.
  // achievement (widget 3) uses dateFrom's month directly; revenueTrend
  // (widget 8) uses it as the trailing-6-month window's end instead of "now".
  async getOverview(
    caller: JwtPayload,
    scope: ScopeInfo,
    dateFrom: string,
    dateTo: string,
    // Agent Activity's team-wide view passes true so every admin-created
    // user is listed, not just manager/consultant — see
    // DealPerformanceDashboardService.getConsultantPerformance's own comment.
    // Defaults false so this endpoint's original consumer (the Analytics
    // Dashboard page's employeeLeaderboard/workBreakdown) is unaffected.
    includeAllUsers = false,
  ): Promise<AnalyticsDashboardOverview> {
    const organizationId = caller.organizationId;
    const scopeId = scope.level === 'store' ? scope.storeId : scope.level === 'user' ? scope.userId : undefined;

    // Real user-reported bug, fixed here: widgets 2/4/5/7 (deal split,
    // leaderboard, work breakdown, won/lost bar) used to filter deals by
    // createdAt for "what did I create/work on this period" framing — correct
    // in principle for natively-created deals, but confirmed live to be badly
    // wrong for an org whose deals all come from the external CRM sync:
    // crm_mongo_sync.py's $setOnInsert stamps createdAt with whenever THIS
    // ORG'S SYNC FIRST RAN, identical across every synced deal regardless of
    // when it actually happened (confirmed live: 42/42 synced deals shared
    // one single createdAt month while their real expectedClosingDate spanned
    // five different months) — so "this month" showed literally every deal
    // the org has ever had, and any other month showed none. Reverted to
    // expectedClosingDate, the same field SalesAnalyticsService.getAchievement
    // already uses (and already trusted) for "Total Revenue"/target math
    // directly above on this same page — auto-stamped to the real close date
    // the moment a deal flips to won/lost (see deals.service.ts's own
    // update() comment), and the one date field the external sync provides
    // that actually reflects real business timing, not sync-ingestion time.
    // A deal with no expectedClosingDate set is honestly excluded from every
    // period rather than guessed into one — same accepted tradeoff
    // getAchievement itself already has. dateFrom is always the 1st of a
    // single selected month (see this method's own leading comment), so its
    // own "YYYY-MM" prefix IS that period.
    const start = new Date(`${dateFrom}T00:00:00.000Z`);
    const end = new Date(`${dateTo}T23:59:59.999Z`);
    const period = dateFrom.slice(0, 7);
    const dealMatch: Record<string, unknown> = {
      organizationId,
      expectedClosingDate: { $regex: `^${period}` },
      ...(scope.level === 'store' && scope.storeId ? { storeId: scope.storeId } : {}),
      ...(scope.level === 'user' && scope.userId ? { ownerId: scope.userId } : {}),
    };
    // Scope only, no date range — used below to resolve which deals are in
    // scope (store/owner) before joining quotes through them; a quote's
    // linked deal can legitimately belong to this store/owner even if that
    // deal itself was created outside the selected period.
    const scopeMatchNoDate: Record<string, unknown> = {
      organizationId,
      ...(scope.level === 'store' && scope.storeId ? { storeId: scope.storeId } : {}),
      ...(scope.level === 'user' && scope.userId ? { ownerId: scope.userId } : {}),
    };
    const quoteDateMatch: Record<string, unknown> = { organizationId, createdAt: { $gte: start, $lte: end } };
    // Quote has no storeId/ownerId of its own — scope via the linked Deal's
    // own storeId/ownerId, same join-through-deals approach
    // quotes.service.ts's listFiltered uses. This resolution is deliberately
    // separate from dealMatch above (both are now createdAt-scoped, but
    // independently — a quote's linked deal can legitimately belong to this
    // store/owner even if that deal itself was created outside this period,
    // so scoping must not reuse the period-filtered deal set).
    if (scope.level === 'store' || scope.level === 'user') {
      const scopedDeals = await this.dealModel.find(scopeMatchNoDate).select({ _id: 1 }).exec();
      quoteDateMatch.dealId = { $in: scopedDeals.map((d) => d._id.toString()) };
    }

    const [
      dealRows,
      quoteRows,
      achievement,
      workforceOverview,
      consultantRows,
      outstandingByOwner,
      revenueTrend,
      emailStats,
      customerBreakdown,
      storeName,
    ] = await Promise.all([
      this.dealModel
        .aggregate<{ _id: string; count: number; value: number }>([
          { $match: dealMatch },
          { $group: { _id: '$dealStatus', count: { $sum: 1 }, value: { $sum: '$monetaryValue' } } },
        ])
        .exec(),
      this.quoteModel
        .aggregate<{ _id: boolean; count: number; value: number }>([
          { $match: quoteDateMatch },
          { $group: { _id: { $eq: ['$clientApprovalStatus', 'approved'] }, count: { $sum: 1 }, value: { $sum: '$quoteAmount' } } },
        ])
        .exec(),
      // dateFrom is always the 1st of a single selected month (see this
      // method's own leading comment) — its own "YYYY-MM" prefix IS that
      // month's period, so achievement/target now honestly tracks whichever
      // month is selected instead of always "now".
      this.salesAnalyticsService.getAchievement(organizationId, scope.level, scopeId, dateFrom.slice(0, 7)),
      this.dashboardService.getOverview(caller),
      this.dealPerformanceDashboardService.getConsultantPerformance(
        organizationId,
        dealMatch,
        scope.level === 'store' ? scope.storeId : undefined,
        undefined,
        includeAllUsers,
      ),
      this.quotesService.getOutstandingByOwner(organizationId),
      // Trailing 6 months ending on the selected month (dateFrom's own
      // "YYYY-MM"), same reasoning as achievement above.
      this.dealPerformanceDashboardService.getRevenueProgress(organizationId, scope.level, scopeId, 6, dateFrom.slice(0, 7)),
      this.emailIntelligenceService.getActivityStats(
        organizationId,
        start,
        end,
        scope.level === 'store' ? scope.storeId : undefined,
        scope.level === 'user' ? scope.userId : undefined,
      ),
      this.customerActivityService.getCustomerBreakdownForRange(
        organizationId,
        start,
        end,
        scope.level === 'store' ? scope.storeId : undefined,
        scope.level === 'user' ? scope.userId : undefined,
      ),
      scope.level === 'store' && scope.storeId ? this.resolveStoreName(organizationId, scope.storeId) : Promise.resolve(undefined),
    ]);

    const byStatus = new Map(dealRows.map((r) => [r._id, r]));
    const wonCount = byStatus.get('won')?.count ?? 0;
    const lostCount = byStatus.get('lost')?.count ?? 0;
    const openCount = byStatus.get('open')?.count ?? 0;
    const wonValue = byStatus.get('won')?.value ?? 0;
    const lostValue = byStatus.get('lost')?.value ?? 0;
    const openValue = byStatus.get('open')?.value ?? 0;

    const accepted = quoteRows.find((r) => r._id === true);
    const notAccepted = quoteRows.find((r) => r._id === false);

    const overdueRatio =
      workforceOverview.stats.totalTasks > 0 ? workforceOverview.stats.overdueCount / workforceOverview.stats.totalTasks : 0;
    const achievementCapped = Math.min(achievement.achievementPct ?? 0, 100);
    // Same weighted composite as business-dashboard.service.ts's Owner
    // businessHealthScore (60% achievement, 40% follow-up health) — kept
    // identical across all three roles rather than making it owner-only;
    // dashboardService.getOverview(caller) already scopes itself down for
    // non-owner callers via chatService.listAgents' own role branching.
    const businessHealthScore = Math.round(achievementCapped * 0.6 + (1 - overdueRatio) * 100 * 0.4);

    // getConsultantPerformance always zero-fills the full roster in scope;
    // for a 'user' scope the roster isn't store-narrowed (dealMatch already
    // restricted the underlying deals to this one ownerId), so post-filter
    // to the caller's own row rather than adding a third scoping param to an
    // already-tested method.
    const scopedConsultantRows =
      scope.level === 'user' && scope.userId ? consultantRows.filter((r) => r.userId === scope.userId) : consultantRows;

    const employeeLeaderboard = scopedConsultantRows
      .map((r) => ({
        userId: r.userId,
        userName: r.userName,
        revenue: r.wonValue,
        wonCount: r.wonCount,
        pipelineValue: r.pipelineValue,
        outstanding: outstandingByOwner.get(r.userId) ?? 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const workBreakdown = scopedConsultantRows.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      wonCount: r.wonCount,
      lostCount: r.lostCount,
      openCount: r.openCount,
      conversionRate: r.conversionRate,
      pipelineValue: r.pipelineValue,
      outstanding: outstandingByOwner.get(r.userId) ?? 0,
    }));

    // Scoped the same way employeeLeaderboard/workBreakdown already are
    // (scopedConsultantRows) — org scope sums everyone in scope, store scope
    // sums just that store's roster, user scope sums just that one user.
    const outstandingTotal = scopedConsultantRows.reduce((sum, r) => sum + (outstandingByOwner.get(r.userId) ?? 0), 0);

    return {
      dateFrom,
      dateTo,
      scope: { level: scope.level, storeId: scope.storeId, storeName, userId: scope.userId },
      emailActivity: emailStats,
      deals: { wonCount, lostCount, openCount, wonValue, lostValue, openValue },
      revenue: { ...achievement, businessHealthScore },
      outstanding: { total: outstandingTotal },
      employeeLeaderboard,
      workBreakdown,
      quotes: {
        acceptedCount: accepted?.count ?? 0,
        acceptedValue: accepted?.value ?? 0,
        notAcceptedCount: notAccepted?.count ?? 0,
        notAcceptedValue: notAccepted?.value ?? 0,
      },
      revenueTrend,
      customers: customerBreakdown,
      aiInsight: this.buildInsight(achievement.achievementPct, wonCount, lostCount, openCount, emailStats.missedCount),
      insights: this.buildInsights(achievement.achievementPct, wonCount, lostCount, openCount, emailStats.missedCount),
    };
  }

  // Deterministic, rule-based text from numbers already computed — never a
  // live LLM call on a dashboard endpoint, matching the one unbroken
  // convention every "AI Insight" in this app already follows. Kept
  // alongside buildInsights() below (same four conditions, same copy) only
  // because aiInsight is still a field on the response — see that field's
  // own comment for why it's not removed.
  private buildInsight(
    achievementPct: number | null,
    wonCount: number,
    lostCount: number,
    openCount: number,
    missedCount: number,
  ): string {
    if (achievementPct !== null && achievementPct < 50) {
      return `Only ${round1(achievementPct)}% of this month's target achieved so far — review the open pipeline for deals that can be accelerated.`;
    }
    if (missedCount > 0) {
      return `${missedCount} email(s) have gone unanswered for over 24 hours — these are the fastest wins to catch up on.`;
    }
    if (lostCount > wonCount && lostCount > 0) {
      return `More deals were lost (${lostCount}) than won (${wonCount}) this month — worth reviewing recent lost-deal reasons for a pattern.`;
    }
    if (openCount > 0) {
      return `${openCount} deal(s) are currently open this month — keep an eye on the ones nearing their expected close date.`;
    }
    return 'Performance is on track — no urgent items flagged for this period.';
  }

  // Same four conditions as buildInsight above, but evaluates every one of
  // them (not just the first match) so the redesigned Overview tab can show
  // every applicable observation instead of only ever the highest-priority
  // one. actionTabId points at AnalyticsDashboardPage's own TAB_ITEMS ids —
  // the frontend only ever switches tabs for these, never navigates
  // anywhere new. Still 100% deterministic/rule-based — no LLM call.
  private buildInsights(
    achievementPct: number | null,
    wonCount: number,
    lostCount: number,
    openCount: number,
    missedCount: number,
  ): AiInsightItem[] {
    const insights: AiInsightItem[] = [];

    if (achievementPct !== null && achievementPct < 50) {
      insights.push({
        severity: 'critical',
        message: `Only ${round1(achievementPct)}% of this month's target achieved so far — review the open pipeline for deals that can be accelerated.`,
        actionTabId: 'pipeline',
        actionLabel: 'View Pipeline',
      });
    }
    if (missedCount > 0) {
      insights.push({
        severity: 'warning',
        message: `${missedCount} email(s) have gone unanswered for over 24 hours — these are the fastest wins to catch up on.`,
        actionTabId: 'customers',
        actionLabel: 'View Customers & Email',
      });
    }
    if (lostCount > wonCount && lostCount > 0) {
      insights.push({
        severity: 'warning',
        message: `More deals were lost (${lostCount}) than won (${wonCount}) this month — worth reviewing recent lost-deal reasons for a pattern.`,
        actionTabId: 'pipeline',
        actionLabel: 'View Pipeline',
      });
    }
    if (openCount > 0) {
      insights.push({
        severity: 'info',
        message: `${openCount} deal(s) are currently open this month — keep an eye on the ones nearing their expected close date.`,
        actionTabId: 'pipeline',
        actionLabel: 'View Pipeline',
      });
    }
    if (insights.length === 0) {
      insights.push({ severity: 'info', message: 'Performance is on track — no urgent items flagged for this period.' });
    }
    return insights;
  }

  private async resolveStoreName(organizationId: string, storeId: string): Promise<string | undefined> {
    const stores = await this.organizationsService.listStores(organizationId);
    return stores.find((s) => s._id.toString() === storeId)?.name;
  }
}
