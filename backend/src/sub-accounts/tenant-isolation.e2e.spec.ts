import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { SchedulerOrchestrator } from '@nestjs/schedule/dist/scheduler.orchestrator';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';

// The whole real application, over real HTTP, against the real dev Mongo: does data
// put in one business stay there, across the modules people actually use? Each
// endpoint is checked both ways, so it also proves the data was really returned to
// the business it belongs to (a filter that hid everything would fail here too).
// Scheduled jobs are off and email is captured. Everything created is removed.

const PREFIX = `jest-isolation-${Date.now()}`;
const email = (name: string) => `${PREFIX}-${name}@example.com`.toLowerCase();

type Business = 'main' | 'subA' | 'subB' | 'other';
const BUSINESSES: Business[] = ['main', 'subA', 'subB', 'other'];
// The ending stops "main" from also matching "mainInSubA".
const mark = (what: string, whose: string) => `${PREFIX}-${what}-${whose}-end`;

describe('Tenant isolation across modules (whole app, real HTTP, real Mongo)', () => {
  let app: INestApplication;
  let base: string;
  let db: Connection;
  let jwt: JwtService;
  const invited = new Map<string, string>();
  const orgIds = {} as Record<Business, string>;
  const allUserIds: string[] = [];

  // Who is asking, and which business they're working in.
  const tokens = {} as Record<'main' | 'mainInSubA' | 'mainInSubB' | 'subAOwner' | 'other', string>;
  const viewers: { name: keyof typeof tokens; business: Business }[] = [
    { name: 'main', business: 'main' },
    { name: 'mainInSubA', business: 'subA' },
    { name: 'mainInSubB', business: 'subB' },
    { name: 'subAOwner', business: 'subA' },
    { name: 'other', business: 'other' },
  ];

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = raw;
    }
    return { status: res.status, body: json, raw };
  }

  const subForm = (name: string) => ({ name: `${PREFIX}-${name}`, businessEmail: email(name), phoneCountryCode: '+91', phone: '9876543210', timezone: 'Asia/Kolkata', currency: 'INR' });
  const live = (organizationId: string) => db.collection('billing_subscriptions').insertOne({ organizationId, planId: 'none', planPriceId: 'none', status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 864e5), cancelAtPeriodEnd: false, renewalFailureCount: 0, createdBy: 'jest', createdAt: new Date() });
  const sub = (token: string) => (jwt.decode(token) as { sub: string }).sub;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SchedulerOrchestrator)
      .useValue({ onApplicationBootstrap() {}, beforeApplicationShutdown() {}, addCron() {}, addTimeout() {}, addInterval() {} })
      .overrideProvider(MailService)
      .useValue({
        invitationLink: (token: string) => `http://app.test/activate?token=${token}`,
        sendInvitationEmail: async (to: string, _n: string, _b: string, token: string) => {
          invited.set(to, token);
        },
        sendWelcomeEmail: async () => undefined,
        sendVerificationOtp: async () => undefined,
        sendPasswordResetOtp: async () => undefined,
        sendNotificationEmail: async () => undefined,
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    db = moduleRef.get(getConnectionToken());
    jwt = moduleRef.get(JwtService);
    const auth = moduleRef.get(AuthService);

    const main = await auth.register(email('main'), 'Passw0rd!23', 'Main Owner', `${PREFIX}-main`, {});
    const other = await auth.register(email('other'), 'Passw0rd!23', 'Other Owner', `${PREFIX}-other`, {});
    tokens.main = main.accessToken;
    tokens.other = other.accessToken;
    orgIds.main = (jwt.decode(main.accessToken) as { organizationId: string }).organizationId;
    orgIds.other = (jwt.decode(other.accessToken) as { organizationId: string }).organizationId;

    orgIds.subA = (await call('POST', '/sub-accounts', tokens.main, subForm('suba'))).body.id;
    orgIds.subB = (await call('POST', '/sub-accounts', tokens.main, subForm('subb'))).body.id;
    await live(orgIds.subA);
    await live(orgIds.subB);

    tokens.mainInSubA = (await call('POST', '/organizations/switch', tokens.main, { organizationId: orgIds.subA })).body.accessToken;
    tokens.mainInSubB = (await call('POST', '/organizations/switch', tokens.main, { organizationId: orgIds.subB })).body.accessToken;
    tokens.subAOwner = (await auth.acceptInvitation(invited.get(email('suba'))!, 'Passw0rd!23')).accessToken;

    // One marked record per module per business.
    const collection = (name: string) => db.collection(name);
    for (const business of BUSINESSES) {
      const organizationId = orgIds[business];
      await collection('vendors').insertOne({ organizationId, name: mark('vendor', business), createdAt: new Date() });
      await collection('agent_roles').insertOne({ organizationId, name: mark('role', business), slug: mark('role', business), status: 'active', createdAt: new Date() });
      await collection('timeline_events').insertOne({ organizationId, type: 'note', title: mark('timeline', business), description: mark('timeline', business), source: 'jest', occurredAt: new Date(), createdAt: new Date() });
      await collection('audit_logs').insertOne({ organizationId, userId: 'jest', method: 'POST', route: `/${mark('audit', business)}`, statusCode: 200, durationMs: 0, createdAt: new Date() });
      await collection('crm_deals').insertOne({ organizationId, name: mark('deal', business), title: mark('deal', business), stage: 'open', value: 1, createdAt: new Date() });
      await collection('wallets').updateOne({ organizationId }, { $set: { balanceCredits: 1000 + BUSINESSES.indexOf(business), reservedCredits: 0 } }, { upsert: true });
    }

    // One marked record per person, for what belongs to a person rather than a business.
    const people = { main: sub(tokens.main), mainInSubA: sub(tokens.mainInSubA), mainInSubB: sub(tokens.mainInSubB), subAOwner: sub(tokens.subAOwner), other: sub(tokens.other) };
    allUserIds.push(...Object.values(people));
    const orgOf: Record<keyof typeof people, string> = { main: orgIds.main, mainInSubA: orgIds.subA, mainInSubB: orgIds.subB, subAOwner: orgIds.subA, other: orgIds.other };
    for (const [person, userId] of Object.entries(people) as [keyof typeof people, string][]) {
      const organizationId = orgOf[person];
      await collection('notifications').insertOne({ userId, organizationId, kind: 'system', title: mark('notification', person), description: 'x', read: false, createdAt: new Date() });
      await collection('conversations').insertOne({ userId, title: mark('chat', person), messages: [], createdAt: new Date(), updatedAt: new Date() });
      await collection('outlook_connections').insertOne({ userId, organizationId, email: `${mark('mailbox', person)}@example.com`.toLowerCase(), isActive: false, createdAt: new Date() });
      await collection('call_sessions').insertOne({ userId, organizationId, status: 'ended', source: 'upload', headline: mark('call', person), creditRequestId: mark('credit', person), transcript: [], createdAt: new Date() });
    }
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const orgs = await db.collection('organizations').find({ slug: { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } }).toArray();
    const users = await db.collection('users').find({ email: { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } }).toArray();
    const ids = orgs.map((o) => o._id.toString());
    const userIds = [...new Set([...users.map((u) => u._id.toString()), ...allUserIds])];
    for (const { name, type } of await db.listCollections()) {
      if (type === 'collection' && name !== 'users' && name !== 'organizations') {
        await db.collection(name).deleteMany({ $or: [{ organizationId: { $in: ids } }, { userId: { $in: userIds } }] });
      }
    }
    await db.collection('users').deleteMany({ _id: { $in: users.map((u) => new Types.ObjectId(u._id)) } });
    await db.collection('organizations').deleteMany({ _id: { $in: orgs.map((o) => new Types.ObjectId(o._id)) } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.close();
  }, 60_000);

  describe('business data appears only in its own business', () => {
    it.each([
      ['vendors', '/vendors', 'vendor'],
      ['AI roles', '/agent-roles', 'role'],
      ['timeline', '/timeline', 'timeline'],
      ['audit log', '/audit-logs', 'audit'],
      ['deals', '/crm/deals', 'deal'],
    ])('%s', async (_label, path, what) => {
      for (const viewer of viewers) {
        const res = await call('GET', path, tokens[viewer.name]);
        const seen = BUSINESSES.filter((business) => res.raw.includes(mark(what, business)));
        expect({ viewer: viewer.name, status: res.status, seen }).toEqual({ viewer: viewer.name, status: 200, seen: [viewer.business] });
      }
    });

    it('each business has its own wallet', async () => {
      for (const viewer of viewers) {
        const res = await call('GET', '/billing/wallet', tokens[viewer.name]);
        expect(res.status).toBe(200);
        expect({ viewer: viewer.name, balance: res.body.balanceCredits }).toEqual({ viewer: viewer.name, balance: 1000 + BUSINESSES.indexOf(viewer.business) });
      }
    });

    it('each business sees only its own people, and its own store', async () => {
      const list = await call('GET', '/users', tokens.mainInSubA);
      const emails: string[] = list.body.map((u: { email: string }) => u.email);
      expect(emails).toContain(email('suba'));
      expect(emails).toContain(email('main')); // labelled as coming from the Main Account
      expect(emails).not.toContain(email('subb'));
      expect(emails).not.toContain(email('other'));

      const stores = await call('GET', '/organizations/stores', tokens.subAOwner);
      expect(stores.body.every((s: { organizationId: string }) => s.organizationId === orgIds.subA)).toBe(true);
      expect((await call('GET', '/organizations/me', tokens.mainInSubB)).body._id).toBe(orgIds.subB);
    });
  });

  describe('a record in another business can’t be reached by its id', () => {
    it('refuses another business’s deal and vendor, even with the exact id', async () => {
      const deal = await db.collection('crm_deals').findOne({ organizationId: orgIds.subA });
      const vendor = await db.collection('vendors').findOne({ organizationId: orgIds.subA });
      expect((await call('GET', `/crm/deals/${deal!._id}`, tokens.mainInSubA)).status).toBe(200);
      expect((await call('GET', `/vendors/${vendor!._id}`, tokens.mainInSubA)).status).toBe(200);
      for (const stranger of ['main', 'mainInSubB', 'other'] as const) {
        expect({ stranger, deal: (await call('GET', `/crm/deals/${deal!._id}`, tokens[stranger])).status }).toEqual({ stranger, deal: 404 });
        expect({ stranger, vendor: (await call('GET', `/vendors/${vendor!._id}`, tokens[stranger])).status }).toEqual({ stranger, vendor: 404 });
      }
    });

    it('can’t be changed from another business either', async () => {
      const vendor = await db.collection('vendors').findOne({ organizationId: orgIds.subA });
      const res = await call('PATCH', `/vendors/${vendor!._id}`, tokens.other, { name: 'hacked' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await db.collection('vendors').findOne({ _id: vendor!._id }))!.name).toBe(mark('vendor', 'subA'));
    });
  });

  describe('what belongs to a person stays with that person', () => {
    // main, mainInSubA and mainInSubB are one human working in three businesses;
    // subAOwner shares a business with mainInSubA but is someone else.
    const PEOPLE = ['main', 'mainInSubA', 'mainInSubB', 'subAOwner', 'other'] as const;

    it.each([
      ['notifications', '/notifications', 'notification'],
      ['chat history', '/chat/conversations', 'chat'],
      ['connected mailboxes', '/outlook/accounts', 'mailbox'],
      ['call recordings', '/call-copilot/sessions', 'call'],
    ])('%s', async (_label, path, what) => {
      for (const person of PEOPLE) {
        const res = await call('GET', path, tokens[person]);
        const seen = PEOPLE.filter((whose) => res.raw.toLowerCase().includes(mark(what, whose).toLowerCase()));
        expect({ person, status: res.status, seen }).toEqual({ person, status: 200, seen: [person] });
      }
      // Chat history goes through the Redis cache, which waits before giving up when Redis isn't running.
    }, 180_000);
  });
});
