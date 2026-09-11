import { randomUUID } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { ReservationService } from '../billing/reservation.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { TimelineService } from '../timeline/timeline.service';
import { FinanceDocument, FinanceDocumentDocument } from './schemas/finance-document.schema';
import { FinanceSummary, FinanceSummaryDocument } from './schemas/finance-summary.schema';
import { FinanceDashboardService } from './finance-dashboard.service';
import { buildFinanceMatchStage } from './finance-filter.util';

const OVERDUE_UPCOMING_WINDOW_DAYS = 30;
const OVERDUE_UPCOMING_LIMIT = 30;
const DUPLICATE_FLAGGED_LIMIT = 20;

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// The Finance AI equivalent of crm/customer-activity.service.ts's
// generateSummary/getCachedSummary — a genuine on-demand, button-triggered
// LLM call (as opposed to finance-dashboard.service.ts's buildFinanceInsight,
// the existing cheap rule-based one-liner, which stays exactly as-is).
@Injectable()
export class FinanceSummaryService {
  private readonly logger = new Logger(FinanceSummaryService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(FinanceDocument.name) private documentModel: Model<FinanceDocumentDocument>,
    @InjectModel(FinanceSummary.name) private summaryModel: Model<FinanceSummaryDocument>,
    private financeDashboardService: FinanceDashboardService,
    private timelineService: TimelineService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
    private reservations: ReservationService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async getCachedSummary(organizationId: string, dateStr: string) {
    const doc = await this.summaryModel.findOne({ organizationId, date: dateStr }).exec();
    return doc ? { ...doc.result, generatedAt: doc.updatedAt } : null;
  }

  async generateSummary(caller: JwtPayload, regenerate: boolean) {
    const dateStr = todayStamp();

    if (!regenerate) {
      const existing = await this.summaryModel.findOne({ organizationId: caller.organizationId, date: dateStr }).exec();
      if (existing) return { summary: { ...existing.result, generatedAt: existing.updatedAt }, cached: true };
    }

    const deterministicInput = await this.gatherDeterministicInput(caller.organizationId);
    // Billed like business-knowledge-chat.service.ts's ask() — reserve() is
    // a hard stop before the LLM call; this is a real, button-triggered
    // action (already throttled at the controller), so a 402 propagates
    // straight through to the HTTP response, same as chat's existing shape.
    const requestId = randomUUID();
    await this.reservations.reserve(caller.organizationId, caller.sub, requestId, 'finance-summary');
    let result: Record<string, unknown>;
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId: caller.organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<Record<string, unknown>>(
          `${this.pythonAgentUrl}/finance/analyze`,
          { ...deterministicInput, request_id: requestId },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      await this.reservations.settle(requestId);
      result = data;
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`Finance activity LLM analysis failed: ${(err as Error).message}`);
      throw err;
    }

    const saved = await this.summaryModel
      .findOneAndUpdate(
        { organizationId: caller.organizationId, date: dateStr },
        {
          $set: {
            organizationId: caller.organizationId,
            date: dateStr,
            requestedByUserId: caller.sub,
            deterministicInput,
            result,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.timelineService.record({
      organizationId: caller.organizationId,
      userId: caller.sub,
      type: 'finance_summary_generated',
      title: "AI summary generated for today's vendor payment activity",
      sourceType: 'finance',
      sourceId: saved._id.toString(),
    });

    return { summary: { ...result, generatedAt: saved.updatedAt }, cached: false };
  }

  // Reuses FinanceDashboardService.getOverview()'s already-computed
  // aggregates verbatim (not recomputed), plus two small new capped queries
  // for the itemized rows a "prioritized payments"/"flagged anomalies"
  // summary needs that getOverview()'s aggregate-only response doesn't
  // carry. Always computed unfiltered (org-wide) — matches
  // customer-activity.service.ts's generateSummary precedent, since the
  // cache key has no filter dimension.
  private async gatherDeterministicInput(organizationId: string) {
    const match = buildFinanceMatchStage(organizationId, {});

    const [overview, overdueAndUpcoming, possibleDuplicates] = await Promise.all([
      this.financeDashboardService.getOverview(organizationId, {}),
      this.documentModel
        .find({ ...match, paymentStatus: { $ne: 'paid' }, dueDate: { $lte: daysFromNow(OVERDUE_UPCOMING_WINDOW_DAYS) } })
        .sort({ dueDate: 1 })
        .limit(OVERDUE_UPCOMING_LIMIT)
        .exec(),
      this.documentModel.find({ ...match, possibleDuplicate: true }).limit(DUPLICATE_FLAGGED_LIMIT).exec(),
    ]);

    return {
      date: todayStamp(),
      summary: overview.summary,
      vendorSpending: overview.vendorSpending,
      microsoftSubscriptionCosts: overview.microsoftSubscriptionCosts,
      categorySpending: overview.categorySpending,
      overdueAndUpcomingPayments: overdueAndUpcoming.map((d) => ({
        documentId: d._id.toString(),
        vendorName: d.vendorName ?? 'Unknown vendor',
        invoiceNumber: d.invoiceNumber,
        customerQuoteNo: d.customerQuoteNo,
        amount: d.paymentAmount,
        dueDate: d.dueDate,
        paymentStatus: d.paymentStatus,
      })),
      possibleDuplicates: possibleDuplicates.map((d) => ({
        documentId: d._id.toString(),
        vendorName: d.vendorName ?? 'Unknown vendor',
        invoiceNumber: d.invoiceNumber,
        amount: d.paymentAmount,
        duplicateOfDocumentId: d.duplicateOfDocumentId,
      })),
    };
  }
}
