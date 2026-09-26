import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { BusinessDashboardService } from '../crm/business-dashboard.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { OutlookConnection, OutlookConnectionDocument } from '../outlook/schemas/outlook-connection.schema';
import { TimelineService } from '../timeline/timeline.service';
import {
  AiRecommendation,
  CriticalAlertGroup,
  EmailSummaryItem,
  HomeDashboardOverview,
  TodaysEmailSummary,
} from './home-dashboard.types';

const EMAIL_URGENT_PRIORITIES = new Set(['urgent', 'high']);

// Lightweight display-only bucketing over the real intent enum — reuses the
// same taxonomy language the user asked for (Urgent/Customer Enquiries/
// Quotations/Follow-ups/Internal — "Approvals" folded in, since every item
// in this self-scoped pending queue is already awaiting the caller's own
// approval by definition). Not a commitment to the full Email Inbox
// taxonomy redesign — that's a separate future phase.
const INTENT_TO_BUCKET: Record<string, string> = {
  new_enquiry: 'Customer Enquiries',
  existing_customer: 'Customer Enquiries',
  quotation_request: 'Quotations',
  price_negotiation: 'Quotations',
  internal: 'Internal',
};

@Injectable()
export class HomeDashboardService {
  constructor(
    @InjectModel(OutlookConnection.name) private outlookConnectionModel: Model<OutlookConnectionDocument>,
    private businessDashboardService: BusinessDashboardService,
    private dashboardService: DashboardService,
    private emailIntelligenceService: EmailIntelligenceService,
    private organizationsService: OrganizationsService,
    private timelineService: TimelineService,
  ) {}

  async getOwnerHome(caller: JwtPayload): Promise<HomeDashboardOverview> {
    const [businessOverview, workforceOverview, emailSummary, missedEodStoreCount, timeline] = await Promise.all([
      this.businessDashboardService.getOwnerOverview(caller),
      this.dashboardService.getOverview(caller),
      this.buildEmailSummary(caller.sub),
      this.countStoresMissingEodToday(caller.organizationId),
      this.timelineService.list(caller.organizationId, { limit: 8 }),
    ]);

    const aiRecommendations = this.buildRecommendations({
      achievementPct: businessOverview.achievementPct,
      riskCount: businessOverview.riskAlerts.length,
      overdueCount: workforceOverview.stats.overdueCount,
      urgentEmailCount: emailSummary.topItems.filter((e) => EMAIL_URGENT_PRIORITIES.has(e.priority)).length,
      missedEodText:
        missedEodStoreCount > 0
          ? `${missedEodStoreCount} ${missedEodStoreCount === 1 ? 'store' : 'stores'} missed today's EOD report.`
          : null,
    });

    const criticalAlerts = this.buildCriticalAlerts({
      dealsAtRisk: businessOverview.riskAlerts,
      overdueTasks: workforceOverview.criticalAlerts,
      urgentEmails: emailSummary.topItems.filter((e) => EMAIL_URGENT_PRIORITIES.has(e.priority)),
      missedEodCount: missedEodStoreCount,
    });

    return {
      generatedAt: new Date().toISOString(),
      aiRecommendations,
      criticalAlerts,
      emailSummary,
      timeline: timeline.map((e) => ({ id: e._id.toString(), type: e.type, title: e.title, occurredAt: e.occurredAt.toISOString() })),
    };
  }

  async getManagerHome(caller: JwtPayload, storeId?: string): Promise<HomeDashboardOverview> {
    const [businessOverview, workforceOverview, emailSummary] = await Promise.all([
      this.businessDashboardService.getManagerOverview(caller, storeId),
      this.dashboardService.getOverview(caller),
      this.buildEmailSummary(caller.sub),
    ]);
    const timeline = await this.timelineService.list(caller.organizationId, { storeId: businessOverview.storeId, limit: 8 });

    const urgentEmails = emailSummary.topItems.filter((e) => EMAIL_URGENT_PRIORITIES.has(e.priority));
    const aiRecommendations = this.buildRecommendations({
      achievementPct: businessOverview.storeAchievement,
      riskCount: businessOverview.dealsAtRisk.length,
      overdueCount: workforceOverview.stats.overdueCount,
      urgentEmailCount: urgentEmails.length,
      missedEodText: businessOverview.missedEodReportToday ? "Today's EOD report hasn't been submitted yet." : null,
    });

    const criticalAlerts = this.buildCriticalAlerts({
      dealsAtRisk: businessOverview.dealsAtRisk,
      overdueTasks: workforceOverview.criticalAlerts,
      urgentEmails,
      missedEodCount: businessOverview.missedEodReportToday ? 1 : 0,
    });

    return {
      generatedAt: new Date().toISOString(),
      aiRecommendations,
      criticalAlerts,
      emailSummary,
      timeline: timeline.map((e) => ({ id: e._id.toString(), type: e.type, title: e.title, occurredAt: e.occurredAt.toISOString() })),
    };
  }

  async getConsultantHome(caller: JwtPayload): Promise<HomeDashboardOverview> {
    const [businessOverview, workforceOverview, emailSummary, timeline] = await Promise.all([
      this.businessDashboardService.getConsultantOverview(caller),
      this.dashboardService.getOverview(caller),
      this.buildEmailSummary(caller.sub),
      this.timelineService.list(caller.organizationId, { userId: caller.sub, limit: 8 }),
    ]);

    const urgentEmails = emailSummary.topItems.filter((e) => EMAIL_URGENT_PRIORITIES.has(e.priority));
    const aiRecommendations = this.buildRecommendations({
      achievementPct: businessOverview.achievementPct,
      riskCount: businessOverview.dealsAtRisk.length,
      overdueCount: workforceOverview.stats.overdueCount,
      urgentEmailCount: urgentEmails.length,
      missedEodText: null,
    });

    const criticalAlerts = this.buildCriticalAlerts({
      dealsAtRisk: businessOverview.dealsAtRisk,
      overdueTasks: workforceOverview.criticalAlerts,
      urgentEmails,
      missedEodCount: 0,
    });

    return {
      generatedAt: new Date().toISOString(),
      aiRecommendations,
      criticalAlerts,
      emailSummary,
      timeline: timeline.map((e) => ({ id: e._id.toString(), type: e.type, title: e.title, occurredAt: e.occurredAt.toISOString() })),
    };
  }

  // Self-scoped to the caller's own connected mailbox only — Email
  // Intelligence has no org-wide oversight view (a deliberate Phase 14b
  // decision, not reopened here). An Owner/Manager with no personally
  // connected Outlook account honestly sees an empty state, not a fake
  // team-wide rollup.
  private async buildEmailSummary(userId: string): Promise<TodaysEmailSummary> {
    const connection = await this.outlookConnectionModel.findOne({ userId, isActive: true }).exec();
    if (!connection) {
      return { connected: false, pendingCount: 0, byIntentBucket: [], topItems: [] };
    }

    const [pending, followUps] = await Promise.all([
      this.emailIntelligenceService.list(userId, { view: 'needs_response' }),
      this.emailIntelligenceService.listFollowUps(userId),
    ]);

    const bucketCounts = new Map<string, number>();
    for (const item of pending) {
      const bucket = INTENT_TO_BUCKET[item.intent] ?? 'Other';
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    }
    if (followUps.length > 0) bucketCounts.set('Follow-ups', followUps.length);

    const priorityRank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    const topItems: EmailSummaryItem[] = [...pending]
      .sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9))
      .slice(0, 5)
      .map((e) => ({
        id: e._id.toString(),
        subject: e.subject || '(no subject)',
        from: e.fromAddress,
        intent: e.intent,
        priority: e.priority,
        receivedAt: e.receivedAt.toISOString(),
      }));

    return {
      connected: true,
      mailboxEmail: connection.email,
      pendingCount: pending.length,
      byIntentBucket: [...bucketCounts.entries()].map(([bucket, count]) => ({ bucket, count })),
      topItems,
    };
  }

  // Org-wide extension of the store-scoped check getManagerOverview already
  // does for one store — loops every store the same way, for Owner's
  // org-wide Critical Alerts/Recommendations tiers.
  private async countStoresMissingEodToday(organizationId: string): Promise<number> {
    const stores = await this.organizationsService.listStores(organizationId);
    const today = new Date().toISOString().slice(0, 10);
    const results = await Promise.all(
      stores.map((s) => this.dashboardService.hasReportToday(organizationId, s._id.toString(), 'eod', today)),
    );
    return results.filter((hasReport) => !hasReport).length;
  }

  // Deterministic, rule-based bullets from numbers already computed — never
  // a new LLM call triggered by dashboard load/polling, matching this
  // codebase's one unbroken "AI insight" convention (buildOwnerInsight,
  // buildManagerRecommendation, buildCoachingTip, Deal Performance's/
  // Finance's equivalents — all cheap if/else text, never a live model call
  // on a 60s-polled endpoint).
  private buildRecommendations(input: {
    achievementPct: number | null;
    riskCount: number;
    overdueCount: number;
    urgentEmailCount: number;
    missedEodText: string | null;
  }): AiRecommendation[] {
    const out: AiRecommendation[] = [];

    if (input.riskCount > 0) {
      out.push({
        id: 'deals-at-risk',
        severity: 'critical',
        text: `${input.riskCount} deal(s) are past their expected close date and need attention.`,
      });
    }
    if (input.missedEodText) {
      out.push({ id: 'missed-eod', severity: 'critical', text: input.missedEodText });
    }
    if (input.urgentEmailCount > 0) {
      out.push({
        id: 'urgent-emails',
        severity: 'warning',
        text: `${input.urgentEmailCount} urgent email(s) awaiting your response.`,
      });
    }
    if (input.overdueCount > 0) {
      out.push({
        id: 'overdue-tasks',
        severity: 'warning',
        text: `${input.overdueCount} task(s) are overdue.`,
      });
    }
    if (input.achievementPct !== null) {
      out.push({
        id: 'target-progress',
        severity: input.achievementPct < 50 ? 'warning' : 'info',
        text: `Today's revenue target is ${input.achievementPct}% complete.`,
      });
    }
    if (out.length === 0) {
      out.push({ id: 'all-clear', severity: 'info', text: 'Everything looks on track — no urgent items right now.' });
    }
    return out;
  }

  private buildCriticalAlerts(input: {
    dealsAtRisk: { dealId: string; name: string; monetaryValue: number; expectedClosingDate?: string }[];
    overdueTasks: { _id: unknown; title: string; priority: string; isOverdue: boolean }[];
    urgentEmails: EmailSummaryItem[];
    missedEodCount: number;
  }): CriticalAlertGroup[] {
    const groups: CriticalAlertGroup[] = [];

    if (input.dealsAtRisk.length > 0) {
      groups.push({
        key: 'deals_at_risk',
        label: 'Deals at Risk',
        count: input.dealsAtRisk.length,
        items: input.dealsAtRisk.slice(0, 5).map((d) => ({
          id: d.dealId,
          title: d.name,
          meta: `Expected close: ${d.expectedClosingDate ?? '—'}`,
          valueLabel: String(d.monetaryValue),
        })),
      });
    }
    if (input.overdueTasks.length > 0) {
      groups.push({
        key: 'overdue_tasks',
        label: 'Overdue Tasks',
        count: input.overdueTasks.length,
        items: input.overdueTasks.slice(0, 5).map((t) => ({ id: String(t._id), title: t.title, meta: t.priority })),
      });
    }
    if (input.missedEodCount > 0) {
      groups.push({ key: 'missed_eod', label: 'Missed EOD Reports', count: input.missedEodCount, items: [] });
    }
    if (input.urgentEmails.length > 0) {
      groups.push({
        key: 'urgent_emails',
        label: 'Urgent Emails',
        count: input.urgentEmails.length,
        items: input.urgentEmails.slice(0, 5).map((e) => ({ id: e.id, title: e.subject, meta: `From ${e.from}` })),
      });
    }
    return groups;
  }
}
