import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChatService } from '../chat/chat.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { DailyReportDocument } from '../dashboard/schemas/daily-report.schema';
import { isTaskVisibleToUser } from '../dashboard/task-visibility.util';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TimelineService } from '../timeline/timeline.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { OrganizationsService } from '../organizations/organizations.service';
import { StoreDocument } from '../organizations/schemas/store.schema';
import { UsersService } from '../users/users.service';

const MORNING_AGENT_ID = 'store_manager';
const MORNING_PROMPT =
  "Generate today's to-do list: analyze CRM and Outlook, identify new enquiries and any that haven't received a follow-up, and list concrete priorities for today.";

const EOD_AGENT_ID = 'store_manager';
const EOD_PROMPT =
  'Generate an end-of-day report: summarize what was completed today, outstanding follow-ups, and anything that needs attention tomorrow.';

// Both scheduled reports are authored by Store Manager (operationally-framed
// daily check-ins fit that role for both morning and evening) — Sales
// Consultant stays available for live chat but isn't the automatic author
// of these two, a deliberate choice.

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Was plain `new Date().toISOString().slice(0,10)` (server UTC) — inconsistent
// with nowMinutesInZone below, which already correctly uses the store's own
// timezone for the trigger-window check. A store far enough from UTC (most
// non-IST timezones) could have its EOD run bucketed under the wrong
// calendar date once the trigger fired near local midnight-adjacent hours.
// Same Intl.DateTimeFormat('en-CA', ...) technique scheduledInstant already
// uses elsewhere in this file, just returning the formatted string directly.
// Exported only for store-settings-date.spec.ts's direct unit test — not
// used anywhere outside this file.
export function todayStamp(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Wall-clock minutes-since-midnight in `tz`, NOT the server process's local
// timezone (that's what broke the trigger window when this runs anywhere
// other than IST, e.g. a container defaulting to UTC). `hour: '2-digit'`
// under `hour12: false` can format midnight as "24" in some ICU builds —
// normalized away with `% 24`.
function nowMinutesInZone(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

// The scheduled instant (today, in `tz`, at `hhmm`) as a real Date — used as
// TimelineEvent.occurredAt for a missed/backfilled run, so the Timeline shows
// what should have happened when, not when the catch-up actually ran.
function scheduledInstant(tz: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return new Date(`${todayParts.year}-${todayParts.month}-${todayParts.day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
}

@Injectable()
export class StoreSettingsService {
  private readonly logger = new Logger(StoreSettingsService.name);

  constructor(
    private organizationsService: OrganizationsService,
    private chatService: ChatService,
    private dashboardService: DashboardService,
    private usersService: UsersService,
    private notificationsService: NotificationsService,
    private timelineService: TimelineService,
    private mailService: MailService,
  ) {}

  getSettings(caller: JwtPayload) {
    return this.organizationsService.resolveStoreForUser(caller.organizationId, caller.storeId);
  }

  updateSettings(caller: JwtPayload, patch: { openingTime?: string; closingTime?: string; timezone?: string }) {
    return this.organizationsService.updateStoreSettings(caller.organizationId, caller.storeId, patch);
  }

  /** Bypasses the trigger window/dedupe check — the manual testing/ops hook
   * exposed via POST /store-settings/run-now. Scoped to the caller's own
   * store only, not every store in every organization. An explicit manual
   * run is never "missed" — that flag only means "the automatic schedule
   * slipped," which doesn't apply here. */
  async runNow(caller: JwtPayload, type: 'morning' | 'eod') {
    const store = await this.organizationsService.resolveStoreForUser(caller.organizationId, caller.storeId);
    const now = new Date().toLocaleDateString();
    const date = todayStamp(store.timezone);
    if (type === 'eod') {
      return this.runForStore(store, EOD_AGENT_ID, 'eod', EOD_PROMPT, `EOD report — ${now}`, false, date);
    }
    return this.runForStore(store, MORNING_AGENT_ID, 'morning', MORNING_PROMPT, `Morning to-do — ${now}`, false, date);
  }

  // A fixed-cadence checker (re-reads current store config every tick)
  // rather than dynamically rescheduling a cron job per store when hours
  // change — mirrors business_sync.py's fixed-interval-rereads-config
  // pattern from the python-agent side. Deliberately NO upper bound on the
  // trigger condition (just "at or after the scheduled minute, not yet run
  // today") — a fixed 30-minute window used to mean a missed tick (e.g. the
  // process was down across the whole window) silently skipped the entire
  // day with no way to catch up. Now the same 10-minute poll picks it up
  // on its next tick, however late, and flags it as missed rather than
  // pretending it ran on time. Iterates every store across every tenant —
  // each store evaluates its own opening/closing window independently.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async checkAndRunDailyJobs() {
    const stores = await this.organizationsService.listAllStores();
    const now = new Date();

    for (const store of stores) {
      // Per-store, not hoisted above the loop — each store's own timezone
      // decides its own "today", and this exact value is what gets passed
      // into both the atomic claim below and runForStore's eventual
      // DailyReport.date, so the two always agree (see todayStamp's comment).
      const today = todayStamp(store.timezone);
      const nowMin = nowMinutesInZone(store.timezone);

      const openMin = toMinutes(store.openingTime);
      if (nowMin >= openMin - 30 && store.lastMorningRunDate !== today) {
        // Claim (atomic check-and-mark) BEFORE running — only the caller
        // whose write actually matched proceeds, so an overlapping second
        // evaluation (another instance, or a manual catch-up run) can never
        // duplicate this store's morning report.
        const claimed = await this.organizationsService.claimMorningRun(store._id.toString(), today);
        if (claimed) {
          const wasMissed = nowMin > openMin;
          await this.runForStore(store, MORNING_AGENT_ID, 'morning', MORNING_PROMPT, `Morning to-do — ${now.toLocaleDateString()}`, wasMissed, today);
        }
      }

      const closeMin = toMinutes(store.closingTime);
      if (nowMin >= closeMin - 30 && store.lastEodRunDate !== today) {
        const claimed = await this.organizationsService.claimEodRun(store._id.toString(), today);
        if (claimed) {
          const wasMissed = nowMin > closeMin;
          await this.runForStore(store, EOD_AGENT_ID, 'eod', EOD_PROMPT, `EOD report — ${now.toLocaleDateString()}`, wasMissed, today);
        }
      }
    }
  }

  private async runForStore(
    store: StoreDocument,
    agentId: string,
    reportType: 'morning' | 'eod',
    promptText: string,
    title: string,
    wasMissed: boolean,
    date: string,
  ) {
    const organizationId = store.organizationId;
    const storeId = store._id.toString();
    const userIds = await this.usersService.findIdsByOrgAndStore(organizationId, storeId);
    const settled = await Promise.allSettled(
      userIds.map((userId) =>
        this.chatService.generateSystemConversation(userId, organizationId, agentId, promptText, title),
      ),
    );
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.error(`Scheduled report failed for user ${userIds[i]}: ${(r.reason as Error).message}`);
      }
    });

    const successes = settled
      .map((r, i) => ({ r, userId: userIds[i] }))
      .filter((x) => x.r.status === 'fulfilled')
      .map((x) => ({ value: (x.r as PromiseFulfilledResult<{ conversationId: string; reply: string }>).value, userId: x.userId }));

    // Exactly one structured DailyReport per (organizationId, agentId,
    // reportType, date) — not one per user. The first successful user
    // (earliest-created, findIdsByOrgAndStore()'s natural order) is only the
    // audit-trail owner (sourceConversationId/sourceUserId) here — the
    // report's actual content comes from dashboardService's own
    // CrewAI-backed generation (independent of any user's plain chat reply,
    // and higher-quality for it), not from chosen.value.reply. A failure
    // here must never break the per-user fan-out above.
    if (successes.length > 0) {
      const chosen = successes[0];
      const savedReport = await this.dashboardService
        .recordDailyReport({
          organizationId,
          storeId,
          agentId,
          reportType,
          date,
          conversationId: chosen.value.conversationId,
          userId: chosen.userId,
          wasMissed,
          userIds,
        })
        .catch((err: Error) => {
          this.logger.error(`Failed to generate ${reportType} report: ${err.message}`);
          return null;
        });

      if (savedReport && reportType === 'eod') {
        await this.sendEodEmail(savedReport, store, userIds);
      }

      const occurredAt = wasMissed ? scheduledInstant(store.timezone, reportType === 'morning' ? store.openingTime : store.closingTime) : new Date();
      await this.timelineService
        .record({
          organizationId,
          storeId,
          type: wasMissed ? 'daily_report_missed' : 'daily_report_generated',
          title: wasMissed ? `${title} (generated late)` : title,
          sourceType: 'daily_report',
          occurredAt,
        })
        .catch((err: Error) => this.logger.error(`Failed to record timeline event: ${err.message}`));

      if (wasMissed) {
        await Promise.allSettled(
          userIds.map((userId) =>
            this.notificationsService.create(
              userId,
              {
                kind: 'warning',
                title: `${reportType === 'morning' ? 'Morning briefing' : 'EOD report'} generated late`,
                description: `${store.name}'s scheduled ${reportType} report ran later than its usual trigger window today.`,
                source: 'store-settings',
              },
              organizationId,
            ),
          ),
        );
      }
    }

    return { usersNotified: successes.length, totalUsers: userIds.length };
  }

  /** Sends the actual EOD report content (not a generic "ready" notice —
   * see mail/templates.ts's dailyReportEmail) to every store user eligible
   * for email per NotificationsService.resolveEmailRecipient (their own
   * preference + the org's policy — the exact same check the rest of the
   * app already uses, not a new one). Each recipient's email is filtered to
   * their own assigned-or-unassigned tasks via isTaskVisibleToUser — the
   * same rule GET /tasks now applies by default — so the report's shared
   * storage never means every user's inbox gets everyone else's assigned
   * tasks; only the still-unassigned/shared items are common to every email.
   * Idempotency: the just-saved report's own _id is a unique document, so a
   * findByIdAndUpdate keyed on it (only from 'pending') is the "mark
   * emailSent" step — re-entering this method for the same report (a cron
   * re-run, a restart) sees emailStatus already 'sent' and does nothing. A
   * send failure sets 'failed' and is otherwise swallowed — it must never
   * affect the already-successfully-saved report above, and there's no
   * retry loop: the next scheduled EOD creates a new DailyReport for the
   * next date, which starts its own 'pending' status. */
  private async sendEodEmail(report: DailyReportDocument, store: StoreDocument, userIds: string[]): Promise<void> {
    if (report.emailStatus === 'sent') return;

    const recipients = (
      await Promise.all(
        userIds.map(async (userId) => {
          const email = await this.notificationsService.resolveEmailRecipient(userId, store.organizationId);
          return email ? { userId, email } : null;
        }),
      )
    ).filter((r): r is { userId: string; email: string } => !!r);

    if (recipients.length === 0) {
      return;
    }

    try {
      const results = await Promise.all(
        recipients.map(({ userId, email }) => {
          const ownTasks = report.tasks.filter((t) => isTaskVisibleToUser(t, userId));
          return this.mailService.sendDailyReportEmail(email, store.name, report.reportType, report.date, ownTasks, report.summary);
        }),
      );
      const anySent = results.some(Boolean);
      await this.dashboardService.markReportEmailStatus(report._id.toString(), anySent ? 'sent' : 'failed', anySent ? undefined : 'All recipient sends failed');
    } catch (err) {
      this.logger.error(`EOD email dispatch failed for report ${report._id.toString()}: ${(err as Error).message}`);
      await this.dashboardService
        .markReportEmailStatus(report._id.toString(), 'failed', (err as Error).message)
        .catch(() => undefined);
    }
  }
}
