import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { SchedulerOrchestrator } from '@nestjs/schedule/dist/scheduler.orchestrator';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Connection, Types } from 'mongoose';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { computePlivoSignatureV3 } from '../plivo/plivo-signature';
import { PlivoService } from '../plivo/plivo.service';
import { TwilioService } from '../twilio/twilio.service';
import { CallingService } from './calling.service';

// The Dialer's calling API through the whole app: real HTTP, the real guards,
// permission checks and sub-account switching, the real dev Mongo. Plivo itself
// is a stand-in HTTP server (no real call is ever placed or billed), and its
// webhooks are signed exactly as Plivo signs them. Everything created here
// starts with PREFIX and is removed in afterAll.

const PREFIX = `jest-calling-${Date.now()}`;
const email = (name: string) => `${PREFIX}-${name}@example.com`.toLowerCase();
const PUBLIC_BASE = 'https://calling.test';
const AUTH_ID = 'MAJESTCALLING0000001';
const AUTH_TOKEN = 'jest-calling-auth-token';
const randomDigits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

describe('Dialer calling API (whole app, real HTTP, real Mongo, stand-in Plivo)', () => {
  let app: INestApplication;
  let base: string;
  let db: Connection;
  let jwt: JwtService;
  let auth: AuthService;
  let fakePlivo: Server;
  const plivoCalls: Record<string, unknown>[] = [];
  let failNextCall: { status: number; body: unknown } | null = null;
  const invited = new Map<string, string>();
  const allUserIds: string[] = [];
  const orgIds: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let ownerId: string;
  let roleSlug: string;
  let noCallsSlug: string;
  let caller: { id: string; token: string };
  let viewer: { id: string; token: string };
  let outsider: { id: string; token: string };
  let legacy: { id: string; token: string };
  const ownerCallIds: string[] = [];

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }

  /** A Plivo webhook as Plivo sends it: form-encoded and signed with the account's token. */
  async function plivoWebhook(path: string, params: Record<string, string>) {
    const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-plivo-signature-v3-nonce': nonce,
        'x-plivo-signature-v3': computePlivoSignatureV3('POST', `${PUBLIC_BASE}${path}`, nonce, AUTH_TOKEN, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, text: await res.text() };
  }

  const sub = (token: string) => (jwt.decode(token) as { sub: string }).sub;
  const live = (organizationId: string) =>
    db.collection('billing_subscriptions').insertOne({
      organizationId,
      planId: 'none',
      planPriceId: 'none',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      cancelAtPeriodEnd: false,
      renewalFailureCount: 0,
      createdBy: 'jest',
      createdAt: new Date(),
    });
  // A call stays "being set up" for two minutes; the next test's call must not wait for it.
  const finish = (id: string) => db.collection('plivo_calls').updateOne({ _id: new Types.ObjectId(id) }, { $set: { status: 'completed' } });
  const addLine = (token: string, userId: string) =>
    call('PUT', '/plivo/lines', token, { plivoNumber: `9180${randomDigits(8)}`, userId, agentPhone: `9198${randomDigits(8)}` });

  async function person(name: string, extra: Record<string, unknown>, slug = roleSlug) {
    const created = await call('POST', '/users', tokens.owner, { email: email(name), name: `${name} person`, role: 'agent_user', assignedAgentId: slug, ...extra });
    if (created.status !== 201) throw new Error(`creating ${name}: ${created.status} ${JSON.stringify(created.body)}`);
    const session = (await auth.login(email(name), created.body.tempPassword, {})) as { accessToken: string };
    allUserIds.push(created.body.user.id);
    return { id: created.body.user.id as string, token: session.accessToken };
  }

  async function aiRole(name: string, features?: string[]) {
    const role = await call('POST', '/agent-roles', tokens.owner, {
      name: `${PREFIX} ${name}`,
      department: 'sales',
      description: 'Calls customers',
      systemPrompt: 'You are a sales assistant.',
    });
    await call('PATCH', `/agent-roles/${role.body._id}`, tokens.owner, { status: 'active', ...(features ? { features } : {}) });
    return role.body.slug as string;
  }

  beforeAll(async () => {
    fakePlivo = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && /^\/v1\/Account\/[^/]+\/$/.test(req.url ?? '')) return send(200, { account_type: 'standard' });
        if (req.method === 'POST' && /^\/v1\/Account\/[^/]+\/Call\/$/.test(req.url ?? '')) {
          const failure = failNextCall;
          failNextCall = null;
          // Slow enough that two taps really do overlap on the server.
          setTimeout(() => {
            if (failure) return send(failure.status, failure.body);
            plivoCalls.push(JSON.parse(raw || '{}'));
            send(201, { request_uuid: `req-${plivoCalls.length}`, message: 'call fired' });
          }, 250);
          return;
        }
        send(404, { error: 'not found' });
      });
    });
    await new Promise<void>((resolve) => fakePlivo.listen(0, '127.0.0.1', resolve));
    const fakeUrl = `http://127.0.0.1:${(fakePlivo.address() as AddressInfo).port}`;
    jest.spyOn(PlivoService.prototype, 'apiBaseUrl', 'get').mockReturnValue(fakeUrl);
    jest.spyOn(PlivoService.prototype, 'publicBaseUrl', 'get').mockReturnValue(PUBLIC_BASE);
    jest.spyOn(TwilioService.prototype, 'publicBaseUrl', 'get').mockReturnValue('');
    // Never probe a real address from a test.
    jest.spyOn(CallingService.prototype, 'reachability').mockResolvedValue('reachable');
    // Every person here calls from 127.0.0.1, so they would share one rate limit
    // (10 call starts a minute) — not what these tests are about.
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);

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
    auth = moduleRef.get(AuthService);

    const owner = await auth.register(email('owner'), 'Passw0rd!23', 'Owner', `${PREFIX}-main`, {});
    const other = await auth.register(email('other'), 'Passw0rd!23', 'Other Owner', `${PREFIX}-other`, {});
    tokens.owner = owner.accessToken;
    tokens.other = other.accessToken;
    ownerId = sub(tokens.owner);
    allUserIds.push(ownerId, sub(tokens.other));
    orgIds.main = (jwt.decode(tokens.owner) as { organizationId: string }).organizationId;
    orgIds.other = (jwt.decode(tokens.other) as { organizationId: string }).organizationId;

    // Both businesses connect Plivo (the stand-in) and give their owner a line.
    for (const who of ['owner', 'other']) {
      const connected = await call('POST', '/plivo/connect', tokens[who], { authId: AUTH_ID, authToken: AUTH_TOKEN });
      if (connected.status !== 201) throw new Error(`connect: ${connected.status} ${JSON.stringify(connected.body)}`);
      const line = await addLine(tokens[who], sub(tokens[who]));
      if (line.status !== 200) throw new Error(`line: ${line.status} ${JSON.stringify(line.body)}`);
    }

    roleSlug = await aiRole('Sales');
    noCallsSlug = await aiRole('No calls', ['email_inbox']);
    caller = await person('caller', { permissions: ['call_copilot:view', 'call_copilot:create'] });
    viewer = await person('viewer', { permissions: ['call_copilot:view'] });
    outsider = await person('outsider', { permissions: ['customers:view'] });
    // No permission list: their AI role's features decide, and this one has no Call Copilot.
    legacy = await person('legacy', {}, noCallsSlug);
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const orgs = await db.collection('organizations').find({ slug: { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } }).toArray();
    const users = await db.collection('users').find({ email: { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } }).toArray();
    const ids = [...new Set([...orgs.map((o) => o._id.toString()), ...Object.values(orgIds)])];
    const userIds = [...new Set([...users.map((u) => u._id.toString()), ...allUserIds])];
    for (const { name, type } of await db.listCollections()) {
      if (type === 'collection' && name !== 'users' && name !== 'organizations') {
        await db.collection(name).deleteMany({ $or: [{ organizationId: { $in: ids } }, { userId: { $in: userIds } }] });
      }
    }
    await db.collection('users').deleteMany({ $or: [{ _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } }, { email: { $regex: `^${PREFIX}` } }] });
    await db.collection('organizations').deleteMany({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.close();
    await new Promise((resolve) => fakePlivo.close(resolve));
  }, 60_000);

  describe('who may use it', () => {
    it('refuses someone without Call Copilot, and an AI role whose features leave it out', async () => {
      expect((await call('GET', '/calling/overview', outsider.token)).status).toBe(403);
      expect((await call('GET', '/calling/calls', outsider.token)).status).toBe(403);
      expect((await call('POST', '/calling/calls', outsider.token, { customerNumber: '+919876543210' })).status).toBe(403);
      // The feature check the calling API lacked: the page was hidden from them, the API was not.
      expect((await call('GET', '/calling/overview', legacy.token)).status).toBe(403);
      expect((await call('POST', '/calling/calls', legacy.token, { customerNumber: '+919876543210' })).status).toBe(403);
    });

    it('lets someone with view only see calls, but not place them or search contacts', async () => {
      expect((await call('GET', '/calling/overview', viewer.token)).status).toBe(200);
      expect((await call('GET', '/calling/calls', viewer.token)).status).toBe(200);
      expect((await call('POST', '/calling/calls', viewer.token, { customerNumber: '+919876543210' })).status).toBe(403);
      expect((await call('GET', '/calling/contacts?search=priya', viewer.token)).status).toBe(403);
      expect(plivoCalls).toHaveLength(0);
    });

    it('lets someone with create place a call once they have a line', async () => {
      const noLine = await call('POST', '/calling/calls', caller.token, { customerNumber: '+919876500001' });
      expect(noLine).toMatchObject({ status: 400, body: { code: 'no_line' } });
      await addLine(tokens.owner, caller.id);
      const placed = await call('POST', '/calling/calls', caller.token, { customerNumber: '+919876500001' });
      expect(placed.status).toBe(201);
      expect(placed.body).toMatchObject({ provider: 'plivo', userId: caller.id, outcome: { stage: 'ringing_agent' } });
      await finish(placed.body.id);
    });
  });

  describe('placing a call', () => {
    it('checks the number before anyone’s phone rings (the 9-digit Indian number)', async () => {
      const before = plivoCalls.length;
      const short = await call('POST', '/calling/calls', tokens.owner, { customerNumber: '+91 934447052' });
      expect(short).toMatchObject({ status: 400, body: { code: 'invalid_number', message: 'Indian numbers have 10 digits after +91 — this one has 9.' } });
      expect(plivoCalls.length).toBe(before);
    });

    it('rings the agent first, then follows Plivo’s reports through to "In call" and "Call ended"', async () => {
      const placed = await call('POST', '/calling/calls', tokens.owner, { customerNumber: '+91 98765 43210', customerName: 'Jest Customer', requestKey: `${PREFIX}-k1`.slice(-40) });
      expect(placed.status).toBe(201);
      const id = placed.body.id as string;
      ownerCallIds.push(id);
      expect(placed.body).toMatchObject({ customerNumber: '919876543210', customerName: 'Jest Customer', outcome: { stage: 'ringing_agent', message: 'Ringing your phone…' } });
      const sent = plivoCalls[plivoCalls.length - 1] as { answer_url: string; to: string };
      expect(sent.answer_url).toBe(`${PUBLIC_BASE}/plivo/webhooks/answer?callId=${id}`);

      const answered = await plivoWebhook(`/plivo/webhooks/answer?callId=${id}`, { CallUUID: `${PREFIX}-uuid` });
      expect(answered.status).toBe(200);
      expect(answered.text).toContain(`/plivo/webhooks/dial-event?callId=${id}`);
      expect((await call('GET', `/calling/calls/plivo/${id}`, tokens.owner)).body.outcome.stage).toBe('connecting_customer');

      await plivoWebhook(`/plivo/webhooks/dial-event?callId=${id}`, { DialAction: 'answer', DialBLegStatus: 'answer' });
      const inCall = await call('GET', `/calling/calls/plivo/${id}`, tokens.owner);
      expect(inCall.body.outcome).toEqual({ stage: 'in_call', message: 'In call' });
      expect(new Date(inCall.body.answeredAt).getTime()).toBeLessThanOrEqual(new Date(inCall.body.serverTime).getTime());

      await plivoWebhook(`/plivo/webhooks/hangup?callId=${id}`, { DialStatus: 'completed', Duration: '63' });
      await plivoWebhook(`/plivo/webhooks/hangup?callId=${id}`, { CallUUID: `${PREFIX}-uuid`, CallStatus: 'completed', HangupCauseName: 'Normal Hangup' });
      const ended = await call('GET', `/calling/calls/plivo/${id}`, tokens.owner);
      expect(ended.body).toMatchObject({ status: 'completed', durationSeconds: 63, outcome: { stage: 'ended' } });
    });

    it('keeps a busy customer "busy" — not "Call ended" — in the call log', async () => {
      const placed = await call('POST', '/calling/calls', tokens.owner, { customerNumber: '+919876500002' });
      const id = placed.body.id as string;
      ownerCallIds.push(id);
      await plivoWebhook(`/plivo/webhooks/answer?callId=${id}`, { CallUUID: `${PREFIX}-busy` });
      await plivoWebhook(`/plivo/webhooks/hangup?callId=${id}`, { DialStatus: 'busy', DialHangupCause: 'USER_BUSY' });
      await plivoWebhook(`/plivo/webhooks/hangup?callId=${id}`, { CallUUID: `${PREFIX}-busy`, CallStatus: 'completed' });
      const log = await call('GET', '/calling/calls', tokens.owner);
      expect(log.body.find((c: { id: string }) => c.id === id)).toMatchObject({
        status: 'busy',
        outcome: { stage: 'failed', failure: 'busy', message: "The customer's line was busy." },
      });
    });

    it('one tap is one call: the same key returns the same call, and a second tap while ringing is refused', async () => {
      const before = plivoCalls.length;
      const key = `k2-${randomDigits(12)}`;
      const first = await call('POST', '/calling/calls', tokens.owner, { customerNumber: '+919876500003', requestKey: key });
      const again = await call('POST', '/calling/calls', tokens.owner, { customerNumber: '+919876500003', requestKey: key });
      expect(first.status).toBe(201);
      expect(again).toMatchObject({ status: 201, body: { id: first.body.id } });
      expect(plivoCalls.length).toBe(before + 1);
      ownerCallIds.push(first.body.id);
      await finish(first.body.id);

      // Two taps at the same moment (different keys): one call, one refusal.
      const both = await Promise.all([
        call('POST', '/calling/calls', tokens.owner, { customerNumber: '+919876500004', requestKey: `k3-${randomDigits(12)}` }),
        call('POST', '/calling/calls', tokens.owner, { customerNumber: '+919876500004', requestKey: `k4-${randomDigits(12)}` }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(both.find((r) => r.status === 409)?.body.code).toBe('call_in_progress');
      expect(plivoCalls.length).toBe(before + 2);
      const placed = both.find((r) => r.status === 201)!.body.id as string;
      ownerCallIds.push(placed);
      await finish(placed);
    });

    it('words an empty Plivo balance plainly, and logs the failed call', async () => {
      failNextCall = { status: 400, body: { error: 'Insufficient balance' } };
      const refused = await call('POST', '/calling/calls', tokens.owner, { customerNumber: '+919876500005' });
      expect(refused).toMatchObject({ status: 400, body: { code: 'balance', message: 'Plivo: Insufficient balance' } });
      const log = await call('GET', '/calling/calls', tokens.owner);
      expect(log.body[0]).toMatchObject({ status: 'failed', outcome: { failure: 'balance' } });
      ownerCallIds.push(log.body[0].id);
    });
  });

  describe('calls stay within their business, sub-account and person', () => {
    it('another business sees none of them and cannot open or retry one', async () => {
      const log = await call('GET', '/calling/calls', tokens.other);
      expect(log.status).toBe(200);
      expect(log.body.map((c: { id: string }) => c.id)).not.toEqual(expect.arrayContaining([ownerCallIds[0]]));
      expect(log.body).toHaveLength(0);
      expect((await call('GET', `/calling/calls/plivo/${ownerCallIds[0]}`, tokens.other)).status).toBe(404);
      expect((await call('POST', `/calling/calls/plivo/${ownerCallIds[0]}/retry-import`, tokens.other)).status).toBe(404);
    });

    it('a colleague in the same business sees only their own calls', async () => {
      const log = await call('GET', '/calling/calls', viewer.token);
      expect(log.body).toHaveLength(0);
      expect((await call('GET', `/calling/calls/plivo/${ownerCallIds[0]}`, viewer.token)).status).toBe(404);
      expect((await call('GET', `/calling/calls/plivo/${ownerCallIds[0]}`, caller.token)).status).toBe(404);
    });

    it('in a sub-account the main account’s calls are out of sight, and calls there stay there', async () => {
      const created = await call('POST', '/sub-accounts', tokens.owner, {
        name: `${PREFIX}-branch`,
        businessEmail: email('branch'),
        phoneCountryCode: '+91',
        phone: '9876543210',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
      });
      expect(created.status).toBe(201);
      orgIds.branch = created.body.id;
      await live(orgIds.branch);
      tokens.ownerInBranch = (await call('POST', '/organizations/switch', tokens.owner, { organizationId: orgIds.branch })).body.accessToken;
      const memberId = sub(tokens.ownerInBranch);
      allUserIds.push(memberId);

      expect((await call('GET', '/calling/calls', tokens.ownerInBranch)).body).toHaveLength(0);
      expect((await call('GET', `/calling/calls/plivo/${ownerCallIds[0]}`, tokens.ownerInBranch)).status).toBe(404);
      // Plivo isn't connected in the branch yet: nothing to call with.
      expect((await call('GET', '/calling/overview', tokens.ownerInBranch)).body).toMatchObject({ canCall: false });
      expect((await call('POST', '/calling/calls', tokens.ownerInBranch, { customerNumber: '+919876500006' })).body.code).toBe('no_line');

      await call('POST', '/plivo/connect', tokens.ownerInBranch, { authId: AUTH_ID, authToken: AUTH_TOKEN });
      await addLine(tokens.ownerInBranch, memberId);
      const placed = await call('POST', '/calling/calls', tokens.ownerInBranch, { customerNumber: '+919876500006' });
      expect(placed).toMatchObject({ status: 201, body: { userId: memberId } });
      expect((await call('GET', '/calling/calls', tokens.ownerInBranch)).body.map((c: { id: string }) => c.id)).toEqual([placed.body.id]);
      // …and back in the main account it is nowhere to be seen.
      expect((await call('GET', '/calling/calls', tokens.owner)).body.map((c: { id: string }) => c.id)).not.toContain(placed.body.id);
      expect((await call('GET', `/calling/calls/plivo/${placed.body.id}`, tokens.owner)).status).toBe(404);
      await finish(placed.body.id);
    });

    it('a sub-account with no live subscription is locked, as everywhere else', async () => {
      const created = await call('POST', '/sub-accounts', tokens.owner, {
        name: `${PREFIX}-unpaid`,
        businessEmail: email('unpaid'),
        phoneCountryCode: '+91',
        phone: '9876543210',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
      });
      orgIds.unpaid = created.body.id;
      const inUnpaid = (await call('POST', '/organizations/switch', tokens.owner, { organizationId: orgIds.unpaid })).body.accessToken;
      allUserIds.push(sub(inUnpaid));
      const refused = await call('GET', '/calling/overview', inUnpaid);
      expect(refused.status).toBe(402);
      expect(refused.body.code).toBe('SUBSCRIPTION_REQUIRED');
    });
  });

  describe('contacts', () => {
    beforeAll(async () => {
      const priya = await call('POST', '/customers', tokens.owner, { name: `${PREFIX} Priya Raman`, phone: '+91 98400 12345', repUserId: caller.id });
      const arjun = await call('POST', '/customers', tokens.owner, { name: `${PREFIX} Arjun Mehta`, phone: '+91 98400 99999' });
      if (priya.status !== 201 || arjun.status !== 201) throw new Error(`customers: ${priya.status} ${JSON.stringify(priya.body)} / ${arjun.status}`);
    });

    it('finds customers by name or by any part of their number', async () => {
      const byName = await call('GET', `/calling/contacts?search=${encodeURIComponent(PREFIX)}`, tokens.owner);
      expect(byName.status).toBe(200);
      expect(byName.body.items.map((c: { name: string }) => c.name).sort()).toEqual([`${PREFIX} Arjun Mehta`, `${PREFIX} Priya Raman`]);
      const byNumber = await call('GET', '/calling/contacts?search=98400 123', tokens.owner);
      expect(byNumber.body.items.find((c: { name: string }) => c.name === `${PREFIX} Priya Raman`)).toMatchObject({ phones: [{ number: '+91 98400 12345' }] });
    });

    it('shows someone who is not a manager only the customers they are the rep of', async () => {
      const mine = await call('GET', `/calling/contacts?search=${encodeURIComponent(PREFIX)}`, caller.token);
      expect(mine.status).toBe(200);
      expect(mine.body.items.map((c: { name: string }) => c.name)).toEqual([`${PREFIX} Priya Raman`]);
    });

    it('never shows another business’s customers', async () => {
      const theirs = await call('GET', `/calling/contacts?search=${encodeURIComponent(PREFIX)}`, tokens.other);
      expect(theirs).toMatchObject({ status: 200, body: { items: [] } });
    });
  });
});
