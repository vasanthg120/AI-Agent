import { randomUUID } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { ReservationService } from '../billing/reservation.service';
import { ChatService } from '../chat/chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { resolveAllowedAgentIds } from './agent-scope.util';
import { DailyReport, DailyReportDocument, DailyReportTask } from './schemas/daily-report.schema';

interface GenerateReportResult {
  reply: string;
  tasks: DailyReportTask[];
  summary: string;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

@Injectable()
export class DashboardService {
  private readonly agentUrl: string;

  constructor(
    @InjectModel(DailyReport.name) private reportModel: Model<DailyReportDocument>,
    private http: HttpService,
    private config: ConfigService,
    private jwt: JwtService,
    private chatService: ChatService,
    private reservations: ReservationService,
  ) {
    this.agentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  /** Generates one representative report via python-agent's CrewAI-backed
   * research -> prioritize -> write crew (app/agent/crew_reports.py) and
   * upserts it as a DailyReport against the (agentId, reportType, date)
   * unique index — called once per scheduled run by
   * StoreSettingsService.runForAllUsers, not once per user. A single round
   * trip to /reports/generate replaces what used to be two calls (a plain
   * chat turn via generateSystemConversation, then a separate
   * /reports/structure call on its reply) — the crew produces its own reply
   * and structures it server-side in one request. */
  async recordDailyReport(input: {
    organizationId: string;
    storeId: string;
    agentId: string;
    reportType: 'morning' | 'eod';
    date: string;
    conversationId: string;
    userId: string;
    wasMissed?: boolean;
  }) {
    // Billed like business-knowledge-chat.service.ts's ask() — reserve() is
    // a hard stop before the crew's LLM calls run. This is invoked once per
    // store by StoreSettingsService.runForStore's cron loop, which already
    // wraps this exact call in a .catch() that logs and continues to the
    // next store — an insufficient-balance org's report is skipped for that
    // run, never blocking the sweep for anyone else.
    const requestId = randomUUID();
    await this.reservations.reserve(input.organizationId, input.userId, requestId, 'scheduled-report');

    // Previously omitted organizationId (unlike every other python-agent
    // bridge token in this codebase) — needed both for python-agent's
    // get_current_user() to resolve org scope and for traced_llm_call's
    // agent_executions attribution to work at all.
    const userJwt = this.jwt.sign({ sub: input.userId, organizationId: input.organizationId }, { expiresIn: '5m' });
    let data: GenerateReportResult;
    try {
      const response = await firstValueFrom(
        this.http.post<GenerateReportResult>(
          `${this.agentUrl}/reports/generate`,
          { report_type: input.reportType, request_id: requestId },
          { headers: { Authorization: `Bearer ${userJwt}` } },
        ),
      );
      data = response.data;
      await this.reservations.settle(requestId);
    } catch (err) {
      await this.reservations.release(requestId);
      throw err;
    }

    return this.reportModel
      .findOneAndUpdate(
        {
          organizationId: input.organizationId,
          storeId: input.storeId,
          agentId: input.agentId,
          reportType: input.reportType,
          date: input.date,
        },
        {
          tasks: data.tasks,
          summary: data.summary,
          sourceConversationId: input.conversationId,
          sourceUserId: input.userId,
          wasMissed: input.wasMissed ?? false,
        },
        { upsert: true, new: true },
      )
      .exec();
  }

  /** Used by the Manager business dashboard's "missed EOD reports" field —
   * a real, answerable query since EOD reports are already store-wide, not
   * per-individual (unlike the per-person task tracking that dashboard has
   * to placeholder). */
  async hasReportToday(organizationId: string, storeId: string, reportType: 'morning' | 'eod', date: string) {
    const count = await this.reportModel.countDocuments({ organizationId, storeId, reportType, date }).exec();
    return count > 0;
  }

  /** agentId, when provided, restricts the response to just that one agent —
   * ON TOP OF the existing RBAC scoping below, never instead of it, so an
   * admin can only drill into an agent they're already allowed to see (a
   * no-op filter for agent_user, whose `agents` array only ever has one
   * entry anyway). Fails closed (404, matching TasksService.updateStatus's
   * convention) rather than silently falling back to the unfiltered view or
   * an ambiguous empty response. */
  async getOverview(caller?: JwtPayload, agentId?: string) {
    const date = todayStamp();
    const [allReports, agents] = await Promise.all([
      // .lean() — plain JS objects, not Mongoose Documents/subdocuments.
      // Spreading a Mongoose subdocument (r.tasks[i]) with {...t} silently
      // drops its schema-defined fields (they live behind getters, not as
      // own enumerable properties), which broke urgentCount/overdueCount
      // below until this was added.
      // organizationId is required on the schema — no caller/org means no
      // reports, not every org's reports (fail closed).
      caller?.organizationId
        ? this.reportModel.find({ organizationId: caller.organizationId, date }).sort({ updatedAt: -1 }).lean().exec()
        : Promise.resolve([]),
      this.chatService.listAgents(caller),
    ]);

    // listAgents(caller) already scopes `agents` down to one entry for an
    // agent_user — but without ALSO filtering the reports themselves,
    // stats/criticalAlerts/recentReports below would still leak every other
    // agent's data even though the agent card list looks correctly scoped.
    let scopedAgentIds = new Set(agents.map((a) => a.id));
    if (agentId) {
      if (!scopedAgentIds.has(agentId)) {
        throw new NotFoundException('Agent not found');
      }
      scopedAgentIds = new Set([agentId]);
    }
    const reports = allReports.filter((r) => scopedAgentIds.has(r.agentId));
    const scopedAgents = agents.filter((a) => scopedAgentIds.has(a.id));

    const byAgent = new Map<string, (typeof reports)[number][]>();
    for (const r of reports) {
      byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
    }

    const agentsOut = scopedAgents.map((a) => {
      const own = byAgent.get(a.id) ?? [];
      const latest = own.find((r) => r.reportType === 'eod') ?? own.find((r) => r.reportType === 'morning');
      return {
        id: a.id,
        name: a.name,
        avatarColor: a.avatarColor,
        status: latest ? ('reported' as const) : ('pending' as const),
        todaysTaskCount: own.reduce((n, r) => n + r.tasks.length, 0),
        lastReportType: latest?.reportType,
        lastReportAt: latest?.updatedAt,
      };
    });

    const allTasks = reports.flatMap((r) =>
      r.tasks.map((t) => ({ ...t, agentId: r.agentId, reportId: r._id.toString() })),
    );
    const urgentCount = allTasks.filter((t) => t.priority === 'urgent').length;
    const overdueCount = allTasks.filter((t) => t.isOverdue).length;
    const totalTasks = allTasks.length;

    return {
      date,
      agents: agentsOut,
      stats: {
        totalTasks,
        urgentCount,
        overdueCount,
        reportsGenerated: reports.length,
        followUpHealthPct: totalTasks === 0 ? null : Math.round((1 - overdueCount / totalTasks) * 100),
      },
      criticalAlerts: allTasks.filter((t) => t.priority === 'urgent' || t.isOverdue).slice(0, 20),
      recentReports: reports.map((r) => ({
        id: r._id.toString(),
        agentId: r.agentId,
        reportType: r.reportType,
        summary: r.summary,
        taskCount: r.tasks.length,
        sourceConversationId: r.sourceConversationId,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Historical per-day breakdown for one agent — always single-agent, used
   * only by the focused drill-down view's trend chart. Every day in the
   * range gets a point (zero-filled), even with no report — a day the agent
   * didn't submit is a meaningful zero, not a gap to skip, matching
   * getOverview's existing "pending" vs "reported" status framing. */
  async getTrend(agentId: string, days: 7 | 30, caller?: JwtPayload) {
    if (!caller?.organizationId) {
      throw new NotFoundException('Agent not found');
    }
    const allowedAgentIds = await resolveAllowedAgentIds(this.chatService, caller);
    if (!allowedAgentIds.includes(agentId)) {
      throw new NotFoundException('Agent not found');
    }

    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const reports = await this.reportModel
      .find({
        organizationId: caller.organizationId,
        agentId,
        date: { $gte: dates[0], $lte: dates[dates.length - 1] },
      })
      .lean()
      .exec();

    const byDate = new Map<string, { totalTasks: number; urgentCount: number; overdueCount: number }>();
    for (const r of reports) {
      const cur = byDate.get(r.date) ?? { totalTasks: 0, urgentCount: 0, overdueCount: 0 };
      cur.totalTasks += r.tasks.length;
      cur.urgentCount += r.tasks.filter((t) => t.priority === 'urgent').length;
      cur.overdueCount += r.tasks.filter((t) => t.isOverdue).length;
      byDate.set(r.date, cur);
    }

    const points = dates.map((date) => {
      const v = byDate.get(date) ?? { totalTasks: 0, urgentCount: 0, overdueCount: 0 };
      return {
        date,
        ...v,
        followUpHealthPct: v.totalTasks === 0 ? null : Math.round((1 - v.overdueCount / v.totalTasks) * 100),
      };
    });
    return { agentId, days, points };
  }
}
