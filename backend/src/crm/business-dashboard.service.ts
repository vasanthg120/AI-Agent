import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { DashboardService } from '../dashboard/dashboard.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import {
  EmailIntelligenceItem,
  EmailIntelligenceItemDocument,
} from '../email-intelligence/schemas/email-intelligence-item.schema';
import { RELEVANT_EMAIL_INTENTS } from '../email-intelligence/email-intelligence.service';
import { needsResponseMatch } from '../email-intelligence/email-response-state';
import { Deal, DealDocument } from './schemas/deal.schema';
import { SalesAnalyticsService } from './sales-analytics.service';

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
}

interface CalendarEventsResponse {
  connected: boolean;
  events: CalendarEvent[];
}

const SALES_ROLES = new Set(['manager', 'consultant']);

interface RevenueRow {
  _id: string;
  revenue: number;
  wonCount: number;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentPeriod(): string {
  return todayStamp().slice(0, 7);
}

function lastNPeriods(n: number): string[] {
  const periods: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return periods;
}

// [start, end) — end is the 1st of the *next* month, an exclusive upper
// bound, so a $lt comparison never needs its own end-of-month math. Built
// with Date.UTC (not the local-timezone Date constructor) so `.toISOString()
// .slice(0, 10)` round-trips back to the same "YYYY-MM-DD" on any server
// timezone — this app's date-only fields (todayStamp() above, DailyReport
// .date) are already all UTC-sliced by convention; a local-timezone
// construction here would silently shift the boundary by a day on an IST
// (or any UTC+) server.
function periodToDateRange(period: string): { start: Date; end: Date } {
  const [year, month] = period.split('-').map(Number);
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

// Per-individual task tracking has no backing data model yet — shipped as
// an explicit "not yet available" marker rather than faked data or a
// throwaway stopgap (see Phase 4 plan notes). Calendar (teamCalendar/
// todaysMeetings) used to be in this bucket too until Phase 8 wired it to
// real Outlook data — see getCalendarEvents below.
const NOT_YET_AVAILABLE = { available: false as const, message: 'Coming in a later phase' };
const CALENDAR_NOT_CONNECTED = { available: false as const, message: 'Connect Outlook in Integrations to see your calendar' };

@Injectable()
export class BusinessDashboardService {
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(EmailIntelligenceItem.name) private emailItemModel: Model<EmailIntelligenceItemDocument>,
    private salesAnalyticsService: SalesAnalyticsService,
    private organizationsService: OrganizationsService,
    private usersService: UsersService,
    private dashboardService: DashboardService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async getOwnerOverview(caller: JwtPayload, period = currentPeriod()) {
    const organizationId = caller.organizationId;
    const { start: periodStart, end: periodEnd } = periodToDateRange(period);

    const [
      achievement,
      revenueTrend,
      storeRankings,
      employeeLeaderboard,
      riskAlerts,
      workforceOverview,
      stores,
      users,
      calendar,
      emailActivityByUser,
    ] = await Promise.all([
      this.salesAnalyticsService.getAchievement(organizationId, 'org', undefined, period),
      this.getRevenueTrend(organizationId, 6),
      this.dealModel
        .aggregate<{ _id: string; revenue: number }>([
          { $match: { organizationId, dealStatus: 'won', storeId: { $exists: true, $ne: null } } },
          { $group: { _id: '$storeId', revenue: { $sum: '$monetaryValue' } } },
          { $sort: { revenue: -1 } },
        ])
        .exec(),
      this.dealModel
        .aggregate<{ _id: string; revenue: number; wonCount: number }>([
          { $match: { organizationId, dealStatus: 'won', ownerId: { $exists: true, $ne: null } } },
          { $group: { _id: '$ownerId', revenue: { $sum: '$monetaryValue' }, wonCount: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
        ])
        .exec(),
      this.dealModel
        .find({ organizationId, dealStatus: 'open', expectedClosingDate: { $lt: todayStamp() } })
        .sort({ expectedClosingDate: 1 })
        .limit(20)
        .exec(),
      this.dashboardService.getOverview(caller),
      this.organizationsService.listStores(organizationId),
      this.usersService.findAll(organizationId),
      // Phase 16 — Owner previously had no calendar data at all (only
      // Manager/Consultant did). Reuses the exact same personal-calendar
      // helper Consultant's todaysMeetings already calls, scoped to the
      // owner's own connected account — for the new Home Dashboard's
      // Today's Meetings add-on.
      this.getUserCalendarEvents(caller.sub, 1),
      this.getEmailActivityByUser(organizationId, periodStart, periodEnd),
    ]);

    const storeNameById = new Map(stores.map((s) => [s._id.toString(), s.name]));

    const overdueRatio =
      workforceOverview.stats.totalTasks > 0 ? workforceOverview.stats.overdueCount / workforceOverview.stats.totalTasks : 0;
    const achievementCapped = Math.min(achievement.achievementPct ?? 0, 100);
    // Simple weighted composite (60% achievement, 40% follow-up health) — an
    // MVP heuristic to give the owner one at-a-glance number, not a model.
    const businessHealthScore = Math.round(achievementCapped * 0.6 + (1 - overdueRatio) * 100 * 0.4);

    return {
      period,
      totalRevenue: achievement.achieved,
      monthlyTarget: achievement.targetAmount,
      achievementPct: achievement.achievementPct,
      remaining: achievement.remaining,
      forecast: { predictedMonthEnd: achievement.predictedMonthEnd, confidence: achievement.forecastConfidence },
      revenueTrend,
      storeRankings: storeRankings.map((r) => ({
        storeId: r._id,
        storeName: storeNameById.get(r._id) ?? 'Unknown store',
        revenue: r.revenue,
      })),
      employeeLeaderboard: this.buildEmployeeLeaderboard(users, employeeLeaderboard, emailActivityByUser),
      businessHealthScore,
      missedTasks: workforceOverview.stats.overdueCount,
      pendingApprovals: [] as unknown[],
      riskAlerts: riskAlerts.map((d) => ({
        dealId: d._id.toString(),
        name: d.name,
        monetaryValue: d.monetaryValue,
        expectedClosingDate: d.expectedClosingDate,
      })),
      aiInsight: this.buildOwnerInsight(achievement.achievementPct, achievement.remaining, riskAlerts.length),
      todaysMeetings: calendar.connected
        ? { available: true as const, events: calendar.events }
        : CALENDAR_NOT_CONNECTED,
    };
  }

  async getManagerOverview(caller: JwtPayload, storeIdOverride: string | undefined, period = currentPeriod()) {
    const organizationId = caller.organizationId;
    const canOverride = caller.roles.includes('admin') || caller.roles.includes('owner');
    const storeId = (canOverride && storeIdOverride) || caller.storeId;
    if (!storeId) {
      throw new BadRequestException('No store assigned to this account');
    }

    const dealFilter = { organizationId, storeId };
    const [achievement, teamPerformance, revenueDeals, followUps, dealsAtRisk, missedEod, users] = await Promise.all([
      this.salesAnalyticsService.getAchievement(organizationId, 'store', storeId, period),
      this.dealModel
        .aggregate<{ _id: string; revenue: number; wonCount: number }>([
          { $match: { ...dealFilter, dealStatus: 'won', ownerId: { $exists: true, $ne: null } } },
          { $group: { _id: '$ownerId', revenue: { $sum: '$monetaryValue' }, wonCount: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
        ])
        .exec(),
      this.dealModel.find({ ...dealFilter, expectedClosingDate: { $regex: `^${period}` } }).exec(),
      this.dealModel
        .find({ ...dealFilter, dealStatus: 'open', expectedClosingDate: { $lte: this.daysFromNow(7) } })
        .sort({ expectedClosingDate: 1 })
        .limit(20)
        .exec(),
      // Phase 16 — store-scoped equivalent of Owner's existing org-wide
      // riskAlerts query, feeding the new Home Dashboard's Critical Alerts
      // tier. followUps above is next-7-days (a different, existing signal);
      // this is genuinely past-due.
      this.dealModel
        .find({ ...dealFilter, dealStatus: 'open', expectedClosingDate: { $lt: todayStamp() } })
        .sort({ expectedClosingDate: 1 })
        .limit(20)
        .exec(),
      this.dashboardService.hasReportToday(organizationId, storeId, 'eod', todayStamp()),
      this.usersService.findAll(organizationId),
    ]);

    const storeTeam = users.filter((u) => u.storeId === storeId);
    const wonCount = revenueDeals.filter((d) => d.dealStatus === 'won').length;
    const conversionRate = revenueDeals.length > 0 ? Math.round((wonCount / revenueDeals.length) * 1000) / 10 : null;

    // Only people who've individually connected their own Outlook show real
    // events — everyone else is simply absent from the list, not an error
    // and not a fake row (same "don't guess" spirit as the employee
    // leaderboard fix). "available: true" here means "we tried," not "the
    // whole team is connected" — an empty list from an all-disconnected team
    // is still a real, honest answer, just an empty one.
    const teamCalendarEvents = (
      await Promise.all(
        storeTeam.map(async (u) => {
          const result = await this.getUserCalendarEvents(u._id.toString(), 1);
          return result.events.map((e) => ({ ...e, userName: u.name }));
        }),
      )
    ).flat();

    return {
      period,
      storeId,
      storeTarget: achievement.targetAmount,
      storeAchievement: achievement.achievementPct,
      revenue: achievement.achieved,
      conversionRate,
      teamPerformance: this.buildEmployeeLeaderboard(storeTeam, teamPerformance),
      followUps: followUps.map((d) => ({
        dealId: d._id.toString(),
        name: d.name,
        monetaryValue: d.monetaryValue,
        expectedClosingDate: d.expectedClosingDate,
      })),
      dealsAtRisk: dealsAtRisk.map((d) => ({
        dealId: d._id.toString(),
        name: d.name,
        monetaryValue: d.monetaryValue,
        expectedClosingDate: d.expectedClosingDate,
      })),
      missedEodReportToday: !missedEod,
      aiRecommendation: this.buildManagerRecommendation(achievement.achievementPct, followUps.length),
      teamCalendar: { available: true as const, events: teamCalendarEvents },
      pendingTasks: NOT_YET_AVAILABLE,
    };
  }

  async getConsultantOverview(caller: JwtPayload, period = currentPeriod()) {
    const organizationId = caller.organizationId;
    const userId = caller.sub;

    const [achievement, pipeline, calendar] = await Promise.all([
      this.salesAnalyticsService.getAchievement(organizationId, 'user', userId, period),
      this.dealModel.find({ organizationId, ownerId: userId, dealStatus: 'open' }).sort({ expectedClosingDate: 1 }).exec(),
      this.getUserCalendarEvents(userId, 1),
    ]);

    const followUps = pipeline.filter((d) => d.expectedClosingDate && d.expectedClosingDate <= this.daysFromNow(7));
    // Phase 16 — personal equivalent of Owner's riskAlerts / Manager's new
    // dealsAtRisk: open deals already past their expected close date, not
    // just approaching one (followUps above). Filtered from the same
    // already-fetched pipeline, no extra query needed.
    const dealsAtRisk = pipeline.filter((d) => d.expectedClosingDate && d.expectedClosingDate < todayStamp());

    return {
      period,
      personalTarget: achievement.targetAmount,
      currentSales: achievement.achieved,
      achievementPct: achievement.achievementPct,
      remainingTarget: achievement.remaining,
      customerPipeline: pipeline.map((d) => ({
        dealId: d._id.toString(),
        name: d.name,
        monetaryValue: d.monetaryValue,
        stageId: d.stageId,
        expectedClosingDate: d.expectedClosingDate,
      })),
      followUps: followUps.map((d) => ({ dealId: d._id.toString(), name: d.name, expectedClosingDate: d.expectedClosingDate })),
      dealsAtRisk: dealsAtRisk.map((d) => ({
        dealId: d._id.toString(),
        name: d.name,
        monetaryValue: d.monetaryValue,
        expectedClosingDate: d.expectedClosingDate,
      })),
      aiCoaching: this.buildCoachingTip(achievement.achievementPct, achievement.remaining, pipeline.length),
      todaysMeetings: calendar.connected
        ? { available: true as const, events: calendar.events }
        : CALENDAR_NOT_CONNECTED,
      todaysTasks: NOT_YET_AVAILABLE,
      missedTasks: NOT_YET_AVAILABLE,
    };
  }

  private async getRevenueTrend(organizationId: string, months: number) {
    const periods = lastNPeriods(months);
    const rows = await this.dealModel
      .aggregate<{ _id: string; revenue: number }>([
        {
          $match: {
            organizationId,
            dealStatus: 'won',
            expectedClosingDate: { $gte: `${periods[0]}-01`, $lte: `${periods[periods.length - 1]}-31` },
          },
        },
        { $group: { _id: { $substrCP: ['$expectedClosingDate', 0, 7] }, revenue: { $sum: '$monetaryValue' } } },
      ])
      .exec();
    const byPeriod = new Map(rows.map((r) => [r._id, r.revenue]));
    return periods.map((period) => ({ period, revenue: byPeriod.get(period) ?? 0 }));
  }

  // Employee-driven, not aggregation-driven: lists every current
  // manager/consultant in scope (so someone with zero won deals still shows
  // up at 0, per the user's ask), and joins in revenue for whoever has some.
  // A revenue row whose ownerId doesn't match any CURRENT employee (e.g. the
  // account that owned it was since deleted/recreated — a real case hit in
  // production) is simply not attributed to anyone, rather than rendering as
  // a fake "Unknown user" row.
  //
  // activityByUser is optional (defaults to empty) — only the Owner
  // Dashboard's org-wide leaderboard passes it (see getOwnerOverview);
  // Manager's store-scoped teamPerformance call reuses this same builder
  // without it, so those columns are simply absent there rather than
  // duplicated at a narrower scope the user didn't ask for.
  //
  // No task-completion-% column: DailyReport.tasks[] is keyed by a shared AI
  // persona slug (e.g. "store_manager"), never an individual employee's
  // userId — confirmed against real data, not assumed — so there is no
  // existing way to attribute a task to one specific person. Flagged rather
  // than shipped as a column that would always read "—".
  private buildEmployeeLeaderboard(
    employees: UserDocument[],
    revenueRows: RevenueRow[],
    activityByUser: Map<string, { emailsSent: number; emailsMissed: number }> = new Map(),
  ) {
    const revenueByOwnerId = new Map(revenueRows.map((r) => [r._id, { revenue: r.revenue, wonCount: r.wonCount }]));
    return employees
      .filter((u) => u.roles.some((r) => SALES_ROLES.has(r)))
      .map((u) => {
        const id = u._id.toString();
        const stats = revenueByOwnerId.get(id);
        const activity = activityByUser.get(id);
        return {
          userId: id,
          userName: u.name,
          revenue: stats?.revenue ?? 0,
          wonCount: stats?.wonCount ?? 0,
          emailsSent: activity?.emailsSent ?? 0,
          emailsMissed: activity?.emailsMissed ?? 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }

  // Sent/missed counts per user for the Owner Dashboard's Employee
  // Leaderboard — same definitions EmailIntelligenceService's own dashboard
  // stat tiles use (buildActivityKindMatch's 'sent'/'missed' cases), just
  // grouped by userId across everyone in the org in one pass instead of one
  // person/store at a time. Deliberately duplicated rather than calling into
  // EmailIntelligenceService directly: CrmModule can never import
  // EmailIntelligenceModule (see the schema-reuse comment in crm.module.ts).
  // "Sent" only covers replies dispatched through the AI Email Inbox's
  // approval queue (EmailIntelligenceItem.sentAt) — not every email a person
  // sends manually in Outlook, since that's the only sent-email record this
  // app persists with a userId attached.
  private async getEmailActivityByUser(
    organizationId: string,
    start: Date,
    end: Date,
  ): Promise<Map<string, { emailsSent: number; emailsMissed: number }>> {
    const relevantIntent = { intent: { $in: RELEVANT_EMAIL_INTENTS } };
    const missedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [sentRows, missedRows] = await Promise.all([
      this.emailItemModel
        .aggregate<{ _id: string; count: number }>([
          { $match: { organizationId, ...relevantIntent, sentAt: { $gte: start, $lt: end } } },
          { $group: { _id: '$userId', count: { $sum: 1 } } },
        ])
        .exec(),
      this.emailItemModel
        .aggregate<{ _id: string; count: number }>([
          {
            $match: {
              organizationId,
              ...relevantIntent,
              // Missed = a reply is owed and nobody has given one, anywhere —
              // the shared definition (this query used to check only the draft's
              // approval status, so a reply typed into Outlook still counted).
              ...needsResponseMatch(),
              receivedAt: { $gte: start, $lt: end, $lte: missedCutoff },
            },
          },
          { $group: { _id: '$userId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const stats = new Map<string, { emailsSent: number; emailsMissed: number }>();
    for (const r of sentRows) stats.set(r._id, { emailsSent: r.count, emailsMissed: 0 });
    for (const r of missedRows) {
      const existing = stats.get(r._id) ?? { emailsSent: 0, emailsMissed: 0 };
      stats.set(r._id, { ...existing, emailsMissed: r.count });
    }
    return stats;
  }

  // Bridge-token pattern used throughout this codebase for backend->
  // python-agent calls (see dashboard.service.ts's recordDailyReport,
  // prospectconnect.py's native CRM fallback). Fails closed to "not
  // connected" on any error (network issue, python-agent down, token
  // expired with no refresh token) — a dashboard widget must never throw
  // just because a personal Outlook connection is having trouble.
  private async getUserCalendarEvents(userId: string, days: number): Promise<CalendarEventsResponse> {
    try {
      const token = this.jwt.sign({ sub: userId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.get<CalendarEventsResponse>(`${this.pythonAgentUrl}/outlook/calendar-events`, {
          params: { days },
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return data;
    } catch {
      return { connected: false, events: [] };
    }
  }

  private daysFromNow(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Deterministic, rule-based text from numbers already computed — not an
  // LLM call on a dashboard endpoint that may poll every 60s (see Phase 3
  // plan notes). Genuine LLM-generated insight belongs to an on-demand
  // action or the future AI Command Center.
  private buildOwnerInsight(achievementPct: number | null, remaining: number | null, riskCount: number): string {
    if (achievementPct === null) return 'No sales target set for this period yet.';
    if (riskCount > 0) return `${riskCount} deal(s) are past their expected close date and need attention.`;
    if (achievementPct >= 100) return `Target achieved for this period at ${achievementPct}%.`;
    return `At ${achievementPct}% of target${remaining ? ` — ${remaining.toLocaleString()} remaining` : ''}.`;
  }

  private buildManagerRecommendation(achievementPct: number | null, followUpCount: number): string {
    if (followUpCount > 0) return `${followUpCount} deal(s) need follow-up in the next 7 days.`;
    if (achievementPct !== null && achievementPct < 50) return 'Store is behind pace on its target this period.';
    return 'No urgent follow-ups — team is on track.';
  }

  private buildCoachingTip(achievementPct: number | null, remaining: number | null, pipelineCount: number): string {
    if (achievementPct === null) return 'No personal target set for this period yet.';
    if (pipelineCount === 0) return 'Your pipeline is empty — focus on prospecting new opportunities.';
    if (remaining && remaining > 0) return `${remaining.toLocaleString()} left to hit target — prioritize your highest-value open deals.`;
    return "You're on track — keep the momentum going.";
  }
}
