import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { BusinessAlertSignals, BusinessesOverviewService, ENQUIRY_ALERT_HOURS, money } from '../analytics-dashboard/businesses-overview.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { businessDayOf } from '../common/business-day';
import { NotificationsService } from '../notifications/notifications.service';
import { isOrganizationBlocked } from '../organizations/schemas/organization.schema';
import { ScopedBusiness, TeamScopeService } from '../team-activity/team-scope.service';
import { BriefingFacts, BriefingFactsService } from './briefing-facts.service';
import { AiConversationSettings, ConversationSchedule, Metric, defaultSettings, inQuietHours, localClock } from './conversation-settings';
import { ConversationSettingsService } from './conversation-settings.service';

export const PROACTIVE_EVENTS = 'ai_proactive_events';
// A schedule is sent in the first ticks after its time; a server that was down longer doesn't send it late.
const SCHEDULE_WINDOW_MINUTES = 30;
// Kept for a while for "how often did Haive reach out" — then they go.
const KEEP_EVENTS_DAYS = 90;

export type AlertKind = 'enquiries' | 'sync' | 'slipped';

/** What Haive sends when it reaches out (no AI: counted figures only). */
export interface ProactiveMessage {
  key: string;
  slot: string;
  kind: 'schedule' | 'alert';
  label: string;
  title: string;
  body: string;
  // Why Haive reached out: the briefing written when it's opened leads with this.
  focus: string;
}

export interface ProactiveRunSummary {
  people: number;
  sent: number;
  quiet: number;
  capped: number;
  failed: number;
}

const ALERT_METRIC: Record<AlertKind, Metric> = { enquiries: 'emails', sync: 'syncHealth', slipped: 'pipeline' };
// Said first: a mailbox or CRM that stopped (it hides everything else), then leads going cold, then slipped deals.
const ALERT_RANK: Record<AlertKind, number> = { sync: 0, enquiries: 1, slipped: 2 };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const shortTime = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(at);

/** Is a schedule due at this local time: at or just after it (within the window). */
export function scheduleDue(schedule: ConversationSchedule, clock: { time: string; weekday: number }): boolean {
  if (!schedule.enabled || !schedule.days.includes(clock.weekday)) return false;
  const gap = minutesOf(clock.time) - minutesOf(schedule.time);
  return gap >= 0 && gap < SCHEDULE_WINDOW_MINUTES;
}

/** The notification for a scheduled briefing: the first things that matter, from the counted facts. */
export function scheduleMessage(schedule: ConversationSchedule, date: string, facts: BriefingFacts): ProactiveMessage {
  const lines: string[] = [...facts.attention.slice(0, 2)];
  for (const b of facts.businesses) {
    if (lines.length >= 2) break;
    const r = b.revenueThisMonth;
    if (r && r.actual > 0) lines.push(`${b.name}: ${money(r.actual, b.currency)} won this month${r.percentOfTarget !== null ? ` (${r.percentOfTarget}% of target)` : ''}.`);
  }
  const t = facts.me.tasks;
  if (lines.length < 2 && t && (t.dueToday || t.overdue)) lines.push(`${plural(t.dueToday, 'task')} due today${t.overdue ? `, ${t.overdue} overdue` : ''}.`);
  if (lines.length < 2 && facts.me.emailsWaitingForMyReply) lines.push(`${plural(facts.me.emailsWaitingForMyReply, 'email')} waiting for your reply.`);
  const said = lines.length ? lines.join(' ') : 'Nothing urgent right now.';
  return {
    key: `schedule:${schedule.id}:${date}`,
    slot: `s-${schedule.id}`,
    kind: 'schedule',
    label: schedule.label,
    title: `${schedule.label} · Haive`,
    body: `${said.length > 200 ? `${said.slice(0, 197)}…` : said} Tap to hear your briefing.`,
    focus: `This is their scheduled "${schedule.label}" (${schedule.time}).`,
  };
}

/** The alerts one business's signals call for, for someone following these metrics. */
export function alertMessages(s: BusinessAlertSignals, metrics: Record<Metric, boolean>, date: string, timeZone: string): ProactiveMessage[] {
  const out: ProactiveMessage[] = [];
  const make = (kind: AlertKind, title: string, body: string, focus: string) =>
    metrics[ALERT_METRIC[kind]] &&
    out.push({ key: `alert:${kind}:${s.businessId}:${date}`, slot: `a-${kind}-${s.businessId}`, kind: 'alert', label: `Alert · ${s.businessName}`, title, body, focus });

  if (s.syncProblems.length > 0) {
    const first = s.syncProblems[0];
    const what = first.kind === 'mailbox' ? `Mailbox ${first.label}` : first.label;
    const since = first.since ?? first.lastOkAt;
    const more = s.syncProblems.length > 1 ? ` (and ${plural(s.syncProblems.length - 1, 'other')})` : '';
    make(
      'sync',
      `${what} ${
        first.status === 'reconnect'
          ? 'needs connecting again'
          : first.status === 'stale'
            ? first.kind === 'mailbox'
              ? 'hasn’t been read lately'
              : 'hasn’t synced lately'
            : first.kind === 'mailbox'
              ? 'isn’t being read'
              : 'stopped syncing'
      } · ${s.businessName}`,
      `${since ? `${first.status === 'stale' ? 'Last worked' : 'Since'} ${shortTime(since, timeZone)}` : 'For a while'}${more}${first.reason ? `: ${first.reason}` : ''}. New ${first.kind === 'mailbox' ? 'emails aren’t' : 'deals aren’t'} coming in.`,
      `${what} at ${s.businessName} ${first.kind === 'mailbox' ? 'is not being read' : 'is not syncing'}${since ? ` since ${shortTime(since, timeZone)}` : ''}${more} — nothing new is coming in from it.`,
    );
  }
  const e = s.enquiriesWaiting;
  if (e.count > 0) {
    make(
      'enquiries',
      `${e.count === 1 ? 'A new enquiry is' : `${e.count} new enquiries are`} waiting · ${s.businessName}`,
      `No reply for over ${ENQUIRY_ALERT_HOURS} hours${e.oldest ? ` — the oldest since ${shortTime(e.oldest, timeZone)}` : ''}. Tap and Haive will brief you.`,
      `${plural(e.count, 'new customer enquiry', 'new customer enquiries')} at ${s.businessName} ${e.count === 1 ? 'has' : 'have'} had no reply for over ${ENQUIRY_ALERT_HOURS} hours${e.oldest ? ` (the oldest arrived ${shortTime(e.oldest, timeZone)})` : ''}.`,
    );
  }
  const d = s.slippedYesterday;
  if (d.count > 0) {
    make(
      'slipped',
      `${plural(d.count, 'deal')} slipped yesterday · ${s.businessName}`,
      `${money(d.value, s.currency)} of open deals passed their closing date without being won.`,
      `${plural(d.count, 'open deal')} at ${s.businessName} worth ${money(d.value, s.currency)} passed their closing date yesterday without being won.`,
    );
  }
  return out;
}

// Haive starting a conversation on its own (AI Conversations settings): at each
// person's scheduled times, and when something in a business needs attention.
// Every 5 minutes it works out, in each person's own time zone, what is due —
// quiet hours and the daily limit respected — and sends a bell and/or push
// notification with counted figures only (no AI cost). The briefing behind it is
// written by the AI only if they open it (GET /assistant/briefing?slot=…), and
// leads with why Haive reached out. Each schedule and alert is claimed once per
// person per day with a unique key, so two servers, or a slow tick, never send
// it twice.
@Injectable()
export class ProactiveService implements OnModuleInit {
  private readonly logger = new Logger(ProactiveService.name);
  private running = false;

  constructor(
    @InjectConnection() private connection: Connection,
    private config: ConfigService,
    private settings: ConversationSettingsService,
    private scopes: TeamScopeService,
    private businesses: BusinessesOverviewService,
    private facts: BriefingFactsService,
    private notifications: NotificationsService,
  ) {}

  private get events() {
    return this.connection.collection(PROACTIVE_EVENTS);
  }

  async onModuleInit(): Promise<void> {
    const warn = (err: Error) => this.logger.warn(`${PROACTIVE_EVENTS} index: ${err.message}`);
    await this.events.createIndex({ userId: 1, organizationId: 1, key: 1 }, { unique: true, name: 'once_per_person' }).catch(warn);
    await this.events.createIndex({ userId: 1, organizationId: 1, date: 1, status: 1 }, { name: 'per_day' }).catch(warn);
    await this.events.createIndex({ createdAt: 1 }, { expireAfterSeconds: KEEP_EVENTS_DAYS * 24 * 60 * 60, name: 'expire' }).catch(warn);
  }

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    if (!(this.config.get<boolean>('assistant.proactiveEnabled') ?? true) || this.running) return;
    this.running = true;
    try {
      const summary = await this.run(new Date());
      if (summary.sent || summary.failed) this.logger.log(`Haive reached out: ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Proactive run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass. `organizationIds` limits it to some businesses (one business on demand; the tests). */
  async run(now = new Date(), options: { organizationIds?: string[] } = {}): Promise<ProactiveRunSummary> {
    const summary: ProactiveRunSummary = { people: 0, sent: 0, quiet: 0, capped: 0, failed: 0 };
    const { organization, people } = await this.settings.loadAll();
    const hasSchedules = (s: AiConversationSettings) => s.schedules.some((x) => x.enabled);
    const orgsWithSchedules = [...organization].filter(([, s]) => hasSchedules(s)).map(([id]) => id);
    const peopleWithSchedules = [...people]
      .filter(([, s]) => hasSchedules(s))
      .map(([key]) => key.split('|')[1])
      .filter((id) => isValidObjectId(id))
      .map((id) => new Types.ObjectId(id));

    // Who might hear from Haive: owners and admins (alerts), and anyone with a schedule (theirs or the company's).
    // Their own login only (not the member records a Main owner uses inside sub-accounts — the Main view covers those).
    const users = await this.connection
      .collection('users')
      .find(
        {
          active: { $ne: false },
          linkedLoginUserId: { $exists: false },
          ...(options.organizationIds ? { organizationId: { $in: options.organizationIds } } : {}),
          $or: [{ roles: { $in: ['owner', 'admin'] } }, { organizationId: { $in: orgsWithSchedules } }, { _id: { $in: peopleWithSchedules } }],
        },
        { projection: { roles: 1, organizationId: 1, storeId: 1, email: 1, department: 1, aiAccessEnabled: 1 } },
      )
      .toArray();
    const orgIds = [...new Set(users.map((u) => String(u.organizationId)))].filter((id) => isValidObjectId(id)).map((id) => new Types.ObjectId(id));
    const orgs = await this.connection.collection('organizations').find({ _id: { $in: orgIds } }, { projection: { status: 1 } }).toArray();
    const blocked = new Set(orgs.filter((o) => isOrganizationBlocked(o.status)).map((o) => o._id.toString()));

    // One look at each business per run, however many people follow it.
    const signals = new Map<string, Promise<BusinessAlertSignals | null>>();
    const signalsOf = (b: ScopedBusiness) => {
      if (!signals.has(b.id)) {
        signals.set(
          b.id,
          this.businesses.alertSignals(b, now).catch((err: Error) => {
            this.logger.warn(`Alert signals for ${b.id} failed: ${err.message}`);
            return null;
          }),
        );
      }
      return signals.get(b.id)!;
    };

    for (const u of users) {
      const organizationId = String(u.organizationId);
      if (blocked.has(organizationId) || u.aiAccessEnabled === false) continue;
      const userId = u._id.toString();
      const settings = people.get(`${organizationId}|${userId}`) ?? organization.get(organizationId) ?? defaultSettings();
      try {
        await this.forPerson(
          { sub: userId, organizationId, roles: u.roles ?? [], storeId: u.storeId, email: u.email ?? '', department: u.department } as JwtPayload,
          settings,
          now,
          signalsOf,
          summary,
        );
      } catch (err) {
        summary.failed += 1;
        this.logger.warn(`Proactive run for ${userId} failed: ${(err as Error).message}`);
      }
    }
    return summary;
  }

  private async forPerson(
    caller: JwtPayload,
    settings: AiConversationSettings,
    now: Date,
    signalsOf: (b: ScopedBusiness) => Promise<BusinessAlertSignals | null>,
    summary: ProactiveRunSummary,
  ): Promise<void> {
    const isAdmin = caller.roles.some((r) => r === 'owner' || r === 'admin');
    const wantsSchedules = settings.schedules.some((s) => s.enabled);
    const wantsAlerts = settings.alerts && isAdmin;
    if ((!wantsSchedules && !wantsAlerts) || settings.maxPerDay === 0 || (!settings.notify.bell && !settings.notify.phone)) return;

    const scope = await this.scopes.resolve(caller);
    const current = scope.businesses.find((b) => b.isCurrent) ?? scope.businesses[0];
    const timeZone = settings.timeZone ?? current?.timeZone ?? 'Asia/Kolkata';
    const clock = localClock(timeZone, now);
    summary.people += 1;
    if (inQuietHours(settings.quietHours, clock.time)) {
      summary.quiet += 1;
      return;
    }
    const date = businessDayOf(timeZone, now);
    const base = { userId: caller.sub, organizationId: caller.organizationId, date };
    let sentToday = await this.events.countDocuments({ ...base, status: 'sent' });

    const due: (() => Promise<ProactiveMessage[]>)[] = [];
    for (const schedule of settings.schedules.filter((s) => scheduleDue(s, clock))) {
      due.push(async () => {
        const facts = await this.facts.build(
          caller,
          { language: settings.language, questions: settings.questions.filter((q) => q.enabled).map((q) => q.text), metrics: settings.metrics },
          now,
        );
        return [scheduleMessage(schedule, date, facts)];
      });
    }
    // Alerts are about a business's figures: for owners and admins who see a whole business.
    // Every business's alerts together, the most serious kind first — so with a small daily limit, a mailbox
    // nobody is reading anywhere is said before a slipped deal in the first business listed.
    if (wantsAlerts && scope.team && !scope.storeId) {
      due.push(async () => {
        const all = (await Promise.all(scope.businesses.map(signalsOf))).flatMap((s) => (s ? alertMessages(s, settings.metrics, date, timeZone) : []));
        return all.sort((a, b) => ALERT_RANK[a.key.split(':')[1] as AlertKind] - ALERT_RANK[b.key.split(':')[1] as AlertKind]);
      });
    }

    for (const next of due) {
      if (sentToday >= settings.maxPerDay) {
        summary.capped += 1;
        return;
      }
      for (const message of await next()) {
        if (sentToday >= settings.maxPerDay) {
          summary.capped += 1;
          return;
        }
        // Already sent today (or being sent by another server)?
        if (await this.events.findOne({ ...base, key: message.key }, { projection: { _id: 1 } })) continue;
        const claimed = await this.events
          .insertOne({ ...base, key: message.key, slot: message.slot, kind: message.kind, label: message.label, title: message.title, body: message.body, focus: message.focus, status: 'sending', createdAt: now })
          .then(() => true)
          .catch((err: { code?: number }) => {
            if (err?.code === 11000) return false;
            throw err;
          });
        if (!claimed) continue;
        try {
          const delivered = await this.notifications.notifyAssistant(
            caller.sub,
            caller.organizationId,
            { title: message.title, body: message.body, slot: message.slot, kind: message.kind === 'alert' ? 'warning' : 'system' },
            settings.notify,
          );
          const ok = delivered.bell || delivered.push;
          await this.events.updateOne({ ...base, key: message.key }, { $set: { status: ok ? 'sent' : 'undelivered', delivered, sentAt: new Date() } });
          if (ok) {
            sentToday += 1;
            summary.sent += 1;
          }
        } catch (err) {
          // Not sent: free the claim so the next tick can try again.
          await this.events.deleteOne({ ...base, key: message.key });
          summary.failed += 1;
          this.logger.warn(`Haive couldn’t reach ${caller.sub}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** The reach-out a briefing slot belongs to (sent to this person in the last day), if any. */
  async eventForSlot(caller: Pick<JwtPayload, 'sub' | 'organizationId'>, slot: string, now = new Date()): Promise<{ label: string; focus: string } | null> {
    const doc = await this.events.findOne(
      { userId: caller.sub, organizationId: caller.organizationId, slot, status: 'sent', createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      { sort: { createdAt: -1 } },
    );
    if (!doc) return null;
    await this.events.updateOne({ _id: doc._id }, { $set: { openedAt: now } });
    return { label: String(doc.label ?? ''), focus: String(doc.focus ?? '') };
  }
}
