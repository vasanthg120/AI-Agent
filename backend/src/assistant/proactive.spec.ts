import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import { BusinessAlertSignals } from '../analytics-dashboard/businesses-overview.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { BriefingFacts } from './briefing-facts.service';
import { defaultSettings } from './conversation-settings';
import { ConversationSettingsService } from './conversation-settings.service';
import { PROACTIVE_EVENTS, ProactiveService, alertMessages, scheduleDue, scheduleMessage } from './proactive.service';

// Haive reaching out on its own: scheduled briefings and attention alerts, in each
// person's time zone, inside their limits, once each per day — notifications only
// (no AI). Real Mongo for who's who, the settings and what was sent; the business
// figures and the notification channels are stand-ins.

const MON_0902_IST = new Date('2026-11-23T03:32:00Z'); // Monday 09:02 in India

describe('ProactiveService (real Mongo for people, settings and what was sent)', () => {
  let connection: Connection;
  let service: ProactiveService;
  let settings: ConversationSettingsService;
  const org = new Types.ObjectId();
  const orgId = org.toString();
  const owner = new Types.ObjectId();
  const staff = new Types.ObjectId();
  const business = { id: orgId, name: 'T.Nagar', timeZone: 'Asia/Kolkata', isCurrent: true, isMain: false, currency: 'INR' };
  let signals: BusinessAlertSignals;
  // What the owner sees, and each business's own signals when a test sets them.
  let ownerBusinesses = [business];
  const signalsById = new Map<string, BusinessAlertSignals>();
  const notifyAssistant = jest.fn(async (_u: string, _o: string, _m: unknown, channels: { bell: boolean; phone: boolean }) => ({ bell: channels.bell, push: channels.phone }));
  const facts = {
    attention: ['T.Nagar: 3 emails waiting for a reply.'],
    businesses: [],
    me: { tasks: { open: 2, inProgress: 0, overdue: 1, dueToday: 1 } },
  } as unknown as BriefingFacts;
  const build = jest.fn(async () => facts);
  const as = (id: Types.ObjectId, roles: string[]) => ({ sub: id.toString(), organizationId: orgId, roles, email: 'x@example.com' }) as JwtPayload;
  const runAt = (at: Date) => service.run(at, { organizationIds: [orgId] });
  const sentTo = (id: Types.ObjectId) => notifyAssistant.mock.calls.filter((c) => c[0] === id.toString()).map((c) => c[2] as { title: string; body: string; slot: string; kind: string });

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
    settings = new ConversationSettingsService(connection);
    const scopes = {
      resolve: async (c: JwtPayload) =>
        c.roles.includes('owner') ? { team: true, acrossBusinesses: ownerBusinesses.length > 1, businesses: ownerBusinesses } : { team: false, acrossBusinesses: false, businesses: [business] },
    };
    service = new ProactiveService(
      connection,
      { get: () => true } as never,
      settings,
      scopes as never,
      { alertSignals: jest.fn(async (b: { id: string }) => signalsById.get(b.id) ?? signals) } as never,
      { build } as never,
      { notifyAssistant } as never,
    );
    await service.onModuleInit();
    await connection.collection('organizations').insertOne({ _id: org, name: 'Jest proactive', status: 'active' });
    await connection.collection('users').insertMany([
      { _id: owner, organizationId: orgId, roles: ['owner'], email: 'owner@example.com', active: true },
      { _id: staff, organizationId: orgId, roles: ['agent_user'], email: 'staff@example.com', active: true },
    ]);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    ownerBusinesses = [business];
    signalsById.clear();
    signals = { businessId: orgId, businessName: 'T.Nagar', currency: 'INR', enquiriesWaiting: { count: 0, oldest: null }, syncProblems: [], slippedYesterday: { count: 0, value: 0 } };
    await connection.collection(PROACTIVE_EVENTS).deleteMany({ organizationId: orgId });
    await connection.collection('ai_conversation_settings').deleteMany({ organizationId: orgId });
    await connection.collection('organizations').updateOne({ _id: org }, { $set: { status: 'active' } });
  });

  afterAll(async () => {
    await connection.collection(PROACTIVE_EVENTS).deleteMany({ organizationId: orgId });
    await connection.collection('ai_conversation_settings').deleteMany({ organizationId: orgId });
    await connection.collection('users').deleteMany({ _id: { $in: [owner, staff] } });
    await connection.collection('organizations').deleteOne({ _id: org });
    await connection.close();
  });

  const morning = { label: 'Morning briefing', time: '09:00', days: [1, 2, 3, 4, 5], enabled: true };

  it('a scheduled briefing: sent once at its time, with counted figures and no AI — not again that day', async () => {
    await settings.updateMine(as(staff, ['agent_user']), { schedules: [morning] });
    const summary = await runAt(MON_0902_IST);
    const [message] = sentTo(staff);
    expect(message).toMatchObject({ title: 'Morning briefing · Haive', kind: 'system' });
    expect(message.slot).toMatch(/^s-[a-z0-9-]+$/i);
    expect(message.body).toBe('T.Nagar: 3 emails waiting for a reply. 1 task due today, 1 overdue. Tap to hear your briefing.');
    expect(summary.sent).toBe(1);
    // Five minutes later, and another server's tick: nothing more.
    await runAt(new Date(MON_0902_IST.getTime() + 5 * 60_000));
    await runAt(new Date(MON_0902_IST.getTime() + 5 * 60_000));
    expect(sentTo(staff)).toHaveLength(1);
    // Staff get no business alerts.
    expect(sentTo(staff).every((m) => m.kind === 'system')).toBe(true);
  });

  it('not before its time, not long after (a server that was down doesn’t send it late), not on days it’s off', async () => {
    await settings.updateMine(as(staff, ['agent_user']), { schedules: [morning] });
    await runAt(new Date('2026-11-23T03:25:00Z')); // 08:55
    await runAt(new Date('2026-11-23T04:05:00Z')); // 09:35
    await runAt(new Date('2026-11-28T03:32:00Z')); // Saturday 09:02
    expect(sentTo(staff)).toHaveLength(0);
  });

  it('the company’s schedule reaches everyone who hasn’t set their own', async () => {
    await settings.updateOrganization(as(owner, ['owner']), { schedules: [morning], alerts: false });
    await runAt(MON_0902_IST);
    expect(sentTo(staff)).toHaveLength(1);
    expect(sentTo(owner)).toHaveLength(1);
  });

  it('quiet hours: nothing proactive, even at a scheduled time', async () => {
    await settings.updateMine(as(staff, ['agent_user']), { schedules: [{ ...morning, time: '21:00' }] });
    const summary = await runAt(new Date('2026-11-23T15:32:00Z')); // 21:02 in India
    expect(sentTo(staff)).toHaveLength(0);
    expect(summary.quiet).toBeGreaterThan(0);
  });

  it('alerts for an owner: a sync failure, waiting enquiries, deals that slipped — each once a day, within the daily limit', async () => {
    signals = {
      ...signals,
      enquiriesWaiting: { count: 3, oldest: new Date('2026-11-23T01:00:00Z') },
      syncProblems: [{ kind: 'mailbox', label: 'enquiry@x.in', status: 'failing', since: new Date('2026-11-20T07:30:00Z') }],
      slippedYesterday: { count: 2, value: 120000 },
    };
    await runAt(MON_0902_IST);
    const sent = sentTo(owner);
    expect(sent.map((m) => m.title)).toEqual([
      'Mailbox enquiry@x.in isn’t being read · T.Nagar',
      '3 new enquiries are waiting · T.Nagar',
      '2 deals slipped yesterday · T.Nagar',
    ]);
    expect(sent.every((m) => m.kind === 'warning')).toBe(true);
    expect(sent[1].body).toBe('No reply for over 2 hours — the oldest since 23 Nov, 6:30 am. Tap and Haive will brief you.');
    expect(sent[2].body).toBe('₹1,20,000 of open deals passed their closing date without being won.');
    // Still true later in the day: not sent again.
    await runAt(new Date(MON_0902_IST.getTime() + 60 * 60_000));
    expect(sentTo(owner)).toHaveLength(3);
    // The staff member sees none of it.
    expect(sentTo(staff)).toHaveLength(0);
  });

  it('the daily limit, the metrics they follow, alerts off, and the channels they chose', async () => {
    signals = { ...signals, enquiriesWaiting: { count: 1, oldest: null }, syncProblems: [{ kind: 'crm', label: 'Hoops', status: 'reconnect' }], slippedYesterday: { count: 1, value: 5000 } };
    await settings.updateMine(as(owner, ['owner']), { maxPerDay: 1 });
    const capped = await runAt(MON_0902_IST);
    expect(sentTo(owner)).toHaveLength(1);
    expect(capped.capped).toBeGreaterThan(0);

    jest.clearAllMocks();
    await connection.collection(PROACTIVE_EVENTS).deleteMany({ organizationId: orgId });
    await settings.updateMine(as(owner, ['owner']), { maxPerDay: 5, metrics: { ...defaultSettings().metrics, emails: false, syncHealth: false }, notify: { bell: false, phone: true } });
    await runAt(MON_0902_IST);
    expect(sentTo(owner).map((m) => m.title)).toEqual(['1 deal slipped yesterday · T.Nagar']);
    expect(notifyAssistant.mock.calls[0][3]).toEqual({ bell: false, phone: true });

    jest.clearAllMocks();
    await connection.collection(PROACTIVE_EVENTS).deleteMany({ organizationId: orgId });
    await settings.updateMine(as(owner, ['owner']), { alerts: false });
    await runAt(MON_0902_IST);
    expect(sentTo(owner)).toHaveLength(0);
  });

  it('across businesses, the most serious alert goes first — a dead mailbox elsewhere beats a slipped deal here', async () => {
    const other = { ...business, id: new Types.ObjectId().toString(), name: 'Shollinganallur', isCurrent: false };
    ownerBusinesses = [business, other];
    signalsById.set(business.id, { ...signals, slippedYesterday: { count: 1, value: 9000 } });
    signalsById.set(other.id, {
      ...signals,
      businessId: other.id,
      businessName: 'Shollinganallur',
      syncProblems: [{ kind: 'mailbox', label: 'enquiry.shol@x.in', status: 'stale', lastOkAt: new Date('2026-11-17T07:30:00Z') }],
    });
    await settings.updateMine(as(owner, ['owner']), { maxPerDay: 1 });
    await runAt(MON_0902_IST);
    expect(sentTo(owner).map((m) => m.title)).toEqual(['Mailbox enquiry.shol@x.in hasn’t been read lately · Shollinganallur']);
  });

  it('when sending fails, nothing is marked sent — the next run tries again', async () => {
    await settings.updateMine(as(staff, ['agent_user']), { schedules: [morning] });
    notifyAssistant.mockRejectedValueOnce(new Error('socket down'));
    const failed = await runAt(MON_0902_IST);
    expect(failed).toMatchObject({ sent: 0, failed: 1 });
    expect(await connection.collection(PROACTIVE_EVENTS).countDocuments({ userId: staff.toString() })).toBe(0);
    const retried = await runAt(new Date(MON_0902_IST.getTime() + 5 * 60_000));
    expect(retried.sent).toBe(1);
    expect(sentTo(staff)).toHaveLength(2);
  });

  it('a business that is suspended hears nothing', async () => {
    signals = { ...signals, enquiriesWaiting: { count: 4, oldest: null } };
    await connection.collection('organizations').updateOne({ _id: org }, { $set: { status: 'suspended' } });
    await runAt(MON_0902_IST);
    expect(notifyAssistant).not.toHaveBeenCalled();
  });

  it('opening it: the slot leads back to why Haive reached out — only for the person it was sent to', async () => {
    signals = { ...signals, enquiriesWaiting: { count: 2, oldest: null } };
    await runAt(MON_0902_IST);
    const [message] = sentTo(owner);
    const reachOut = await service.eventForSlot(as(owner, ['owner']), message.slot, new Date(MON_0902_IST.getTime() + 60_000));
    expect(reachOut).toEqual({ label: 'Alert · T.Nagar', focus: '2 new customer enquiries at T.Nagar have had no reply for over 2 hours.' });
    expect((await connection.collection(PROACTIVE_EVENTS).findOne({ userId: owner.toString(), slot: message.slot }))?.openedAt).toBeInstanceOf(Date);
    expect(await service.eventForSlot(as(staff, ['agent_user']), message.slot)).toBeNull();
    // A day later the link is just today's briefing.
    expect(await service.eventForSlot(as(owner, ['owner']), message.slot, new Date(MON_0902_IST.getTime() + 25 * 60 * 60_000))).toBeNull();
  });
});

describe('what Haive says when it reaches out', () => {
  const clock = (time: string, weekday = 1) => ({ time, weekday });
  const s = { id: 'abc', label: 'Morning briefing', time: '09:00', days: [1, 2, 3, 4, 5], enabled: true };

  it('scheduleDue: at the time and up to half an hour after, on its days, when on', () => {
    expect(scheduleDue(s, clock('09:00'))).toBe(true);
    expect(scheduleDue(s, clock('09:29'))).toBe(true);
    expect(scheduleDue(s, clock('09:30'))).toBe(false);
    expect(scheduleDue(s, clock('08:59'))).toBe(false);
    expect(scheduleDue(s, clock('09:05', 6))).toBe(false);
    expect(scheduleDue({ ...s, enabled: false }, clock('09:05'))).toBe(false);
  });

  it('a quiet day still gets an honest line', () => {
    const quiet = { attention: [], businesses: [], me: {} } as unknown as BriefingFacts;
    expect(scheduleMessage(s, '2026-11-23', quiet).body).toBe('Nothing urgent right now. Tap to hear your briefing.');
    expect(scheduleMessage(s, '2026-11-23', quiet).key).toBe('schedule:abc:2026-11-23');
  });

  it('alerts follow the metrics: a CRM that needs connecting again, in the business’s own money', () => {
    const signals: BusinessAlertSignals = {
      businessId: 'b1',
      businessName: 'Surryhills',
      currency: 'AUD',
      enquiriesWaiting: { count: 0, oldest: null },
      syncProblems: [{ kind: 'crm', label: 'Hoops', status: 'reconnect' }],
      slippedYesterday: { count: 3, value: 741000 },
    };
    const all = alertMessages(signals, defaultSettings().metrics, '2026-11-23', 'Australia/Sydney');
    expect(all.map((m) => m.title)).toEqual(['Hoops needs connecting again · Surryhills', '3 deals slipped yesterday · Surryhills']);
    expect(all[1].body).toBe('A$741,000 of open deals passed their closing date without being won.');
    const noPipeline = alertMessages(signals, { ...defaultSettings().metrics, pipeline: false }, '2026-11-23', 'Australia/Sydney');
    expect(noPipeline.map((m) => m.slot)).toEqual(['a-sync-b1']);
  });

  it('a mailbox that has gone quiet for days is said plainly, with when it last worked', () => {
    const signals: BusinessAlertSignals = {
      businessId: 'b2',
      businessName: 'Shollinganallur',
      currency: 'INR',
      enquiriesWaiting: { count: 0, oldest: null },
      syncProblems: [{ kind: 'mailbox', label: 'enquiry.shol@x.in', status: 'stale', lastOkAt: new Date('2026-11-17T07:30:00Z') }],
      slippedYesterday: { count: 0, value: 0 },
    };
    const [m] = alertMessages(signals, defaultSettings().metrics, '2026-11-23', 'Asia/Kolkata');
    expect(m.title).toBe('Mailbox enquiry.shol@x.in hasn’t been read lately · Shollinganallur');
    expect(m.body).toBe('Last worked 17 Nov, 1:00 pm. New emails aren’t coming in.');
  });
});
