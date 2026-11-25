import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, isValidObjectId } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { nextDay, startOfBusinessDay } from '../common/business-day';
import { EmployeeSignIn, EmployeeSignInDocument, SignInKind } from './schemas/employee-sign-in.schema';
import { EmployeeUsageHour, EmployeeUsageHourDocument } from './schemas/employee-usage-hour.schema';
import { UsageArea, isUsageArea } from './usage-areas';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** A tab that lost its connection may send what it measured up to a day late. */
const MAX_BEAT_AGE = 26 * HOUR;
/** A break longer than this starts a new work session. */
export const SESSION_GAP = 15 * MINUTE;
/** A call left open (a closed tab, a line never hung up) counts for four hours at most. */
const MAX_CALL = 4 * HOUR;
const MAX_SIGN_INS = 100;

export interface UsageBeat {
  // Start of the minute, as the browser's clock read it (ISO).
  minute: string;
  area: string;
  // Active seconds in that minute so far (1–60).
  seconds: number;
}

export interface WorkSession {
  start: Date;
  end: Date;
  activeSeconds: number;
}

export type AreaSeconds = Partial<Record<UsageArea, number>>;

/** One business day of someone's measured activity. */
export interface UsageDay {
  date: string;
  // HaiVE in use, or on a call — a minute doing both counts once.
  activeSeconds: number;
  haiveSeconds: number;
  callSeconds: number;
  byArea: AreaSeconds;
  firstAt: Date;
  lastAt: Date;
  // Unbroken stretches of activity (a break of 15 minutes or more ends one).
  sessions: WorkSession[];
}

export interface PersonUsage {
  activeSeconds: number;
  haiveSeconds: number;
  callSeconds: number;
  byArea: AreaSeconds;
  activeDays: number;
  firstAt?: Date;
  lastAt?: Date;
  // Days with any activity, oldest first.
  days: UsageDay[];
}

export interface SignInRow {
  at: Date;
  kind: Exclude<SignInKind, 'sign_out'>;
  device?: string;
  location?: string;
  // When it ended with a sign-out; unknown when the session simply expired.
  signedOutAt?: Date;
  // The session is still open now.
  open: boolean;
}

type Doc = Record<string, any>;

interface Range {
  from: string;
  to: string;
  start: Date;
  end: Date;
}

/** Merges overlapping [from, to) intervals. */
function union(intervals: [number, number][]): [number, number][] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const round = (n: number) => Math.round(n);

function roundAreas(areas: AreaSeconds): AreaSeconds {
  const out: AreaSeconds = {};
  for (const [area, seconds] of Object.entries(areas) as [UsageArea, number][]) if (seconds >= 1) out[area] = round(seconds);
  return out;
}

// Employee Activity's measured time: how long each person really worked in
// HaiVE (and in which part of it), and on calls — never "the app was open".
//
// - HaiVE time comes from the browser (frontend hooks/useUsageTracker.ts): a
//   second counts only with the HaiVE tab in front, its window focused, and a
//   click, key press, scroll or touch in the last two minutes.
// - Call time comes from the calls themselves: a phone call from answer to
//   hang-up, a live Call Copilot call from start to end.
// - A minute both in HaiVE and on a call counts once (the larger of the two),
//   so nothing is added twice.
// - Sign-ins and sign-outs are recorded by AuthService as they happen; the
//   sessions a login still holds give their sign-in time too.
// Other apps (Outlook, the CRMs, Gmail) report what was done, not for how long:
// Employee Activity shows those as activity, never as time.
@Injectable()
export class EmployeeUsageService {
  private readonly logger = new Logger(EmployeeUsageService.name);

  constructor(
    @InjectModel(EmployeeUsageHour.name) private hours: Model<EmployeeUsageHourDocument>,
    @InjectModel(EmployeeSignIn.name) private signIns: Model<EmployeeSignInDocument>,
    @InjectConnection() private connection: Connection,
  ) {}

  // ---- recording ---------------------------------------------------------------------------

  /**
   * Stores what the browser measured: active seconds per minute and part of the app,
   * for the person signed in, in the business they are working in. Only a real
   * signed-in session counts (never an API token or a service). The browser's clock
   * is corrected against the server's; minutes in the future or over a day old,
   * unknown parts of the app, and impossible numbers are dropped.
   */
  async record(caller: JwtPayload, input: { beats: UsageBeat[]; sentAt?: string }, now = new Date()): Promise<{ recorded: number }> {
    if (caller.authMethod !== 'session' || !caller.organizationId || !caller.sub) return { recorded: 0 };
    const clientNow = input.sentAt ? Date.parse(input.sentAt) : Number.NaN;
    // Whole minutes only: a clock a few seconds out moves nothing.
    const skew = Number.isFinite(clientNow) ? Math.round((now.getTime() - clientNow) / MINUTE) * MINUTE : 0;

    const merged = new Map<string, number>();
    for (const beat of input.beats ?? []) {
      const raw = Date.parse(beat.minute);
      if (!Number.isFinite(raw) || !isUsageArea(beat.area)) continue;
      const minute = Math.floor((raw + skew) / MINUTE) * MINUTE;
      if (minute > now.getTime() || minute < now.getTime() - MAX_BEAT_AGE) continue;
      const seconds = Math.min(60, Math.round(Number(beat.seconds)));
      if (!(seconds >= 1)) continue;
      const key = `${minute}|${beat.area}`;
      merged.set(key, Math.max(merged.get(key) ?? 0, seconds));
    }
    if (merged.size === 0) return { recorded: 0 };

    const byHour = new Map<number, { max: Record<string, number>; first: number; last: number }>();
    for (const [key, seconds] of merged) {
      const [minuteText, area] = key.split('|');
      const minute = Number(minuteText);
      const hour = Math.floor(minute / HOUR) * HOUR;
      const mm = String((minute - hour) / MINUTE).padStart(2, '0');
      const entry = byHour.get(hour) ?? { max: {}, first: minute, last: minute };
      entry.max[`m.${mm}.${area}`] = seconds;
      entry.first = Math.min(entry.first, minute);
      entry.last = Math.max(entry.last, Math.min(minute + MINUTE, now.getTime()));
      byHour.set(hour, entry);
    }
    const ops = [...byHour].map(([hour, e]) => ({
      updateOne: {
        filter: { organizationId: caller.organizationId, userId: caller.sub, hour: new Date(hour) },
        update: { $max: { ...e.max, lastAt: new Date(e.last) }, $min: { firstAt: new Date(e.first) } },
        upsert: true,
      },
    }));
    try {
      await this.hours.collection.bulkWrite(ops, { ordered: false });
    } catch (error) {
      // Two tabs creating the same hour at once: one insert loses the race. Again, now that it exists.
      if ((error as { code?: number }).code !== 11000) throw error;
      await this.hours.collection.bulkWrite(ops, { ordered: false });
    }
    return { recorded: merged.size };
  }

  /** A sign-in, sign-out or move into another business, as it happens. Never fails the sign-in itself. */
  async logSignIn(
    entry: { organizationId: string; userId: string; kind: SignInKind; jti?: string; device?: string; location?: string },
    at = new Date(),
  ): Promise<void> {
    try {
      await this.signIns.create({ ...entry, at });
    } catch (error) {
      this.logger.warn(`Couldn't record ${entry.kind} for ${entry.userId}: ${(error as Error).message}`);
    }
  }

  // ---- reading -----------------------------------------------------------------------------

  /** Each person's seconds per minute and part of HaiVE, in [start, end). */
  private async haiveMinutes(organizationId: string, userIds: string[], start: Date, end: Date): Promise<Map<string, Map<number, Record<string, number>>>> {
    const out = new Map<string, Map<number, Record<string, number>>>();
    if (userIds.length === 0) return out;
    const docs = await this.hours
      .find(
        { organizationId, userId: { $in: userIds }, hour: { $gte: new Date(Math.floor(start.getTime() / HOUR) * HOUR), $lt: end } },
        { userId: 1, hour: 1, m: 1 },
      )
      .lean<{ userId: string; hour: Date; m?: Record<string, Record<string, number>> }[]>()
      .exec();
    for (const doc of docs) {
      const minutes = out.get(doc.userId) ?? new Map<number, Record<string, number>>();
      for (const [mm, areas] of Object.entries(doc.m ?? {})) {
        const minute = doc.hour.getTime() + Number(mm) * MINUTE;
        if (minute < start.getTime() || minute >= end.getTime()) continue;
        const clean: Record<string, number> = {};
        for (const [area, seconds] of Object.entries(areas ?? {})) {
          if (isUsageArea(area) && typeof seconds === 'number' && seconds > 0) clean[area] = Math.min(60, seconds);
        }
        if (Object.keys(clean).length) minutes.set(minute, clean);
      }
      out.set(doc.userId, minutes);
    }
    return out;
  }

  /** Each person's seconds on a call per minute, in [start, end): phone calls from answer to hang-up, live Call Copilot calls start to end. */
  private async callMinutes(organizationId: string, userIds: string[], start: Date, end: Date, now: Date): Promise<Map<string, Map<number, number>>> {
    const out = new Map<string, Map<number, number>>();
    if (userIds.length === 0) return out;
    const earliest = new Date(start.getTime() - MAX_CALL);
    const phone = { organizationId, userId: { $in: userIds }, answeredAt: { $gte: earliest, $lt: end } };
    const col = (name: string) => this.connection.collection(name);
    const [plivo, twilio, live] = await Promise.all([
      col('plivo_calls')
        .find(phone, { projection: { userId: 1, answeredAt: 1, durationSeconds: 1 } })
        .toArray(),
      col('twilio_calls')
        .find(phone, { projection: { userId: 1, answeredAt: 1, durationSeconds: 1 } })
        .toArray(),
      col('call_sessions')
        .find(
          { organizationId, userId: { $in: userIds }, source: 'live', createdAt: { $gte: earliest, $lt: end } },
          { projection: { userId: 1, createdAt: 1, endedAt: 1 } },
        )
        .toArray(),
    ]);
    // A live session that is a phone call's recording is that phone call: counted once, above.
    const liveIds = live.map((s) => s._id.toString());
    const linked = new Set<string>(
      liveIds.length
        ? (
            await Promise.all([
              col('plivo_calls').distinct('sessionId', { organizationId, sessionId: { $in: liveIds } }),
              col('twilio_calls').distinct('sessionId', { organizationId, sessionId: { $in: liveIds } }),
            ])
          )
            .flat()
            .map(String)
        : [],
    );
    const intervals = new Map<string, [number, number][]>();
    const add = (userId: unknown, from: number, to: number) => {
      const key = String(userId);
      const list = intervals.get(key) ?? [];
      list.push([from, Math.min(to, from + MAX_CALL, now.getTime())]);
      intervals.set(key, list);
    };
    for (const call of [...plivo, ...twilio] as Doc[]) {
      const seconds = Number(call.durationSeconds) || 0;
      if (call.answeredAt instanceof Date && seconds > 0) add(call.userId, call.answeredAt.getTime(), call.answeredAt.getTime() + seconds * SECOND);
    }
    for (const session of live as Doc[]) {
      if (linked.has(session._id.toString())) continue;
      if (session.createdAt instanceof Date && session.endedAt instanceof Date) add(session.userId, session.createdAt.getTime(), session.endedAt.getTime());
    }
    for (const [userId, list] of intervals) {
      const minutes = new Map<number, number>();
      for (const [a, b] of union(list)) {
        const from = Math.max(a, start.getTime());
        const to = Math.min(b, end.getTime());
        for (let m = Math.floor(from / MINUTE) * MINUTE; m < to; m += MINUTE) {
          const overlap = Math.min(to, m + MINUTE) - Math.max(from, m);
          if (overlap > 0) minutes.set(m, Math.min(60, (minutes.get(m) ?? 0) + overlap / SECOND));
        }
      }
      if (minutes.size) out.set(userId, minutes);
    }
    return out;
  }

  /**
   * Each person's measured activity in the period, day by day in the business's own
   * timezone: time active (HaiVE or a call, a minute counted once), HaiVE time by part
   * of the app, call time, first and last activity, and work sessions.
   * People with nothing measured are left out.
   */
  async measure(organizationId: string, timeZone: string, userIds: string[], range: Range, now = new Date()): Promise<Map<string, PersonUsage>> {
    const result = new Map<string, PersonUsage>();
    if (userIds.length === 0) return result;
    const [haive, calls] = await Promise.all([
      this.haiveMinutes(organizationId, userIds, range.start, range.end),
      this.callMinutes(organizationId, userIds, range.start, range.end, now),
    ]);

    // The start of each business day of the range, to put every minute on its own day.
    const dayStarts: { date: string; start: number }[] = [];
    for (let d = range.from; d <= range.to; d = nextDay(d)) dayStarts.push({ date: d, start: startOfBusinessDay(timeZone, d).getTime() });
    const dayOf = (ms: number) => {
      let lo = 0;
      let hi = dayStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (dayStarts[mid].start <= ms) lo = mid;
        else hi = mid - 1;
      }
      return dayStarts[lo].date;
    };

    for (const userId of new Set([...haive.keys(), ...calls.keys()])) {
      const h = haive.get(userId) ?? new Map<number, Record<string, number>>();
      const c = calls.get(userId) ?? new Map<number, number>();
      const minutes = [...new Set([...h.keys(), ...c.keys()])].sort((a, b) => a - b);
      const days = new Map<string, UsageDay>();
      let session: WorkSession | null = null;
      let previous = Number.NEGATIVE_INFINITY;
      for (const minute of minutes) {
        const areas = h.get(minute) ?? {};
        const sum = Object.values(areas).reduce((s, v) => s + v, 0);
        const haiveSeconds = Math.min(60, sum);
        // Two devices at once can't make a minute longer than 60 seconds.
        const scale = sum > 60 ? 60 / sum : 1;
        const callSeconds = c.get(minute) ?? 0;
        const active = Math.max(haiveSeconds, callSeconds);
        if (active <= 0) continue;
        const date = dayOf(minute);
        const endOfMinute = new Date(Math.min(minute + MINUTE, now.getTime()));
        const day: UsageDay = days.get(date) ?? {
          date,
          activeSeconds: 0,
          haiveSeconds: 0,
          callSeconds: 0,
          byArea: {},
          firstAt: new Date(minute),
          lastAt: endOfMinute,
          sessions: [],
        };
        day.activeSeconds += active;
        day.haiveSeconds += haiveSeconds;
        day.callSeconds += callSeconds;
        for (const [area, seconds] of Object.entries(areas) as [UsageArea, number][]) day.byArea[area] = (day.byArea[area] ?? 0) + seconds * scale;
        day.lastAt = endOfMinute;
        if (!session || minute - previous > SESSION_GAP) {
          session = { start: new Date(minute), end: endOfMinute, activeSeconds: 0 };
          day.sessions.push(session);
        }
        session.end = endOfMinute;
        session.activeSeconds += active;
        previous = minute;
        days.set(date, day);
      }
      if (days.size === 0) continue;

      const person: PersonUsage = { activeSeconds: 0, haiveSeconds: 0, callSeconds: 0, byArea: {}, activeDays: days.size, days: [] };
      for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
        const rounded: UsageDay = {
          ...day,
          activeSeconds: round(day.activeSeconds),
          haiveSeconds: round(day.haiveSeconds),
          callSeconds: round(day.callSeconds),
          byArea: roundAreas(day.byArea),
          sessions: day.sessions.map((s) => ({ ...s, activeSeconds: round(s.activeSeconds) })),
        };
        person.days.push(rounded);
        person.activeSeconds += rounded.activeSeconds;
        person.haiveSeconds += rounded.haiveSeconds;
        person.callSeconds += rounded.callSeconds;
        for (const [area, seconds] of Object.entries(rounded.byArea) as [UsageArea, number][]) person.byArea[area] = (person.byArea[area] ?? 0) + seconds;
      }
      person.firstAt = person.days[0]?.firstAt;
      person.lastAt = person.days[person.days.length - 1]?.lastAt;
      result.set(userId, person);
    }
    return result;
  }

  /** When each person was last active in HaiVE (any time, not only in a period); absent when never measured. */
  async lastActive(organizationId: string, userIds: string[]): Promise<Map<string, Date>> {
    const rows = await Promise.all(
      userIds.map((userId) =>
        this.hours
          .findOne({ organizationId, userId }, { lastAt: 1 })
          .sort({ hour: -1 })
          .lean<{ lastAt?: Date }>()
          .exec()
          .then((doc) => [userId, doc?.lastAt] as const),
      ),
    );
    return new Map(rows.filter((r): r is readonly [string, Date] => r[1] instanceof Date));
  }

  /** The first minute ever measured in a business: app usage is known from then on. */
  async measuredSince(organizationIds: string[]): Promise<Date | null> {
    if (organizationIds.length === 0) return null;
    const first = await this.hours
      .findOne({ organizationId: { $in: organizationIds } }, { firstAt: 1, hour: 1 })
      .sort({ hour: 1 })
      .lean<{ firstAt?: Date; hour: Date }>()
      .exec();
    return first ? (first.firstAt ?? first.hour) : null;
  }

  /**
   * Someone's sign-ins in the period, newest first, each with its sign-out when one
   * was recorded. A session the login still holds counts too (its sign-in time is
   * stored with it), so sign-ins from before this log began still show while open.
   */
  async signInHistory(organizationId: string, userId: string, start: Date, end: Date): Promise<SignInRow[]> {
    const [logged, user] = await Promise.all([
      this.signIns
        .find({ organizationId, userId, at: { $gte: start, $lt: end }, kind: { $in: ['sign_in', 'switch_in'] } })
        .sort({ at: -1 })
        .limit(MAX_SIGN_INS)
        .lean<Doc[]>()
        .exec(),
      isValidObjectId(userId)
        ? this.connection.collection('users').findOne({ _id: new Types.ObjectId(userId), organizationId }, { projection: { sessions: 1 } })
        : null,
    ]);
    const open = new Map<string, Doc>(((user?.sessions as Doc[] | undefined) ?? []).map((s) => [String(s.jti), s]));
    const rows: (SignInRow & { jti?: string })[] = logged.map((r) => ({
      at: r.at,
      kind: r.kind,
      device: r.device,
      location: r.location,
      jti: r.jti,
      open: !!r.jti && open.has(r.jti),
    }));
    const seen = new Set(rows.map((r) => r.jti).filter(Boolean));
    for (const s of open.values()) {
      if (seen.has(String(s.jti)) || !(s.createdAt instanceof Date) || s.createdAt < start || s.createdAt >= end) continue;
      rows.push({ at: s.createdAt, kind: 'sign_in', device: s.device, location: s.location, jti: String(s.jti), open: true });
    }
    const jtis = rows.map((r) => r.jti).filter((j): j is string => !!j);
    const outs = jtis.length
      ? await this.signIns
          .find({ organizationId, userId, kind: 'sign_out', jti: { $in: jtis } }, { jti: 1, at: 1 })
          .lean<{ jti: string; at: Date }[]>()
          .exec()
      : [];
    const outAt = new Map(outs.map((o) => [o.jti, o.at]));
    return rows
      .map(({ jti, ...row }) => ({ ...row, ...(jti && outAt.has(jti) ? { signedOutAt: outAt.get(jti), open: false } : {}) }))
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, MAX_SIGN_INS);
  }
}
