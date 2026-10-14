import { Injectable } from '@nestjs/common';
import { DealFilterQueryDto } from '../crm/dto/deal-filter-query.dto';
import { buildDealMatchStage } from '../crm/deal-filter.util';
import { DealPerformanceDashboardService } from '../crm/deal-performance-dashboard.service';
import { QuotesService } from '../crm/quotes.service';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { UsersService } from '../users/users.service';

// Who is listed: UsersService.findTeamRoster (common/team-roster.ts) — the same
// roster the email and deal columns use, so the three never disagree.

interface DomainBucket {
  assigned: number;
  completed: number;
  pending: number;
  overdue: number;
}

export interface EmployeeProductivityRow {
  userId: string;
  userName: string;
  emails: DomainBucket;
  quotes: DomainBucket;
  deals: DomainBucket & { wonCount: number; lostCount: number; wonValue: number };
  overallCompletionPct: number | null;
}

const ZERO_BUCKET: DomainBucket = { assigned: 0, completed: 0, pending: 0, overdue: 0 };

@Injectable()
export class EmployeeProductivityService {
  constructor(
    private usersService: UsersService,
    private dealPerformanceDashboardService: DealPerformanceDashboardService,
    private quotesService: QuotesService,
    private emailIntelligenceService: EmailIntelligenceService,
  ) {}

  async getOverview(
    organizationId: string,
    start: Date,
    end: Date,
    filters: { employeeId?: string[]; storeId?: string[] },
  ): Promise<{ rows: EmployeeProductivityRow[]; quoteCoveragePct: number | null }> {
    const roster = await this.resolveRoster(organizationId, filters);

    // Reuses buildDealMatchStage — the same date-boundary/UTC-handling logic
    // deals.controller.ts's own listFiltered/export paths already trust,
    // never a second hand-rolled definition of "in range". dateField:
    // 'expectedClosingDate', NOT the default createdAt — same real bug and
    // fix as analytics-dashboard.service.ts's own dealMatch (see its
    // comment): for an org whose deals all come from the external CRM sync,
    // createdAt reflects only "when this org's sync first ran", identical
    // across every synced deal regardless of real timing, which would make
    // this column's Deals numbers show every synced deal for one month and
    // none for any other. expectedClosingDate is the real close date and the
    // same field SalesAnalyticsService.getAchievement already trusts.
    const dateFrom = start.toISOString().slice(0, 10);
    const dateTo = new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10);
    const storeConstraint = filters.storeId?.length === 1 ? filters.storeId[0] : undefined;
    const dealFilters = {
      dateFrom,
      dateTo,
      dateField: 'expectedClosingDate',
      storeId: filters.storeId,
      ownerId: filters.employeeId,
    } as DealFilterQueryDto;
    const dealMatch = buildDealMatchStage(organizationId, dealFilters, storeConstraint);

    const [dealRows, dealAging, quoteStats, emailStats] = await Promise.all([
      // Called verbatim — never reimplemented — so this column can never
      // disagree with the Deal Performance dashboard's own numbers for the
      // same employee/range (Phase 3's own verification requirement).
      this.dealPerformanceDashboardService.getConsultantPerformance(organizationId, dealMatch, storeConstraint, filters.storeId),
      this.dealPerformanceDashboardService.getOpenDealAgingByOwner(organizationId, dealMatch),
      this.quotesService.getConsultantQuoteStats(organizationId, start, end, roster),
      this.emailIntelligenceService.getEmailProductivityStats(organizationId, start, end, filters),
    ]);

    const dealByOwner = new Map(dealRows.map((r) => [r.userId, r]));
    const quoteByOwner = new Map(quoteStats.rows.map((r) => [r.userId, r]));
    const emailByOwner = new Map(emailStats.map((r) => [r.userId, r]));

    const rows: EmployeeProductivityRow[] = roster.map((r) => {
      const deal = dealByOwner.get(r.userId);
      const aging = dealAging.get(r.userId) ?? { pending: 0, overdue: 0 };
      const quote = quoteByOwner.get(r.userId) ?? ZERO_BUCKET;
      const email = emailByOwner.get(r.userId) ?? ZERO_BUCKET;

      const wonCount = deal?.wonCount ?? 0;
      const lostCount = deal?.lostCount ?? 0;
      const openCount = deal?.openCount ?? 0;
      const deals = { assigned: wonCount + lostCount + openCount, completed: wonCount + lostCount, ...aging, wonCount, lostCount, wonValue: deal?.wonValue ?? 0 };

      return {
        userId: r.userId,
        userName: r.userName,
        emails: email,
        quotes: quote,
        deals,
        overallCompletionPct: this.completionPct(email, quote, deals),
      };
    });

    return { rows, quoteCoveragePct: quoteStats.coveragePct };
  }

  private completionPct(email: DomainBucket, quote: DomainBucket, deals: DomainBucket): number | null {
    const totalAssigned = email.assigned + quote.assigned + deals.assigned;
    const totalCompleted = email.completed + quote.completed + deals.completed;
    return totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 1000) / 10 : null;
  }

  private async resolveRoster(
    organizationId: string,
    filters: { employeeId?: string[]; storeId?: string[] },
  ): Promise<{ userId: string; userName: string }[]> {
    const users = await this.usersService.findTeamRoster(organizationId);
    return users
      .filter(
        (u) =>
          (!filters.storeId?.length || (u.storeId && filters.storeId.includes(u.storeId))) &&
          (!filters.employeeId?.length || filters.employeeId.includes(u._id.toString())),
      )
      .map((u) => ({ userId: u._id.toString(), userName: u.name }));
  }
}
