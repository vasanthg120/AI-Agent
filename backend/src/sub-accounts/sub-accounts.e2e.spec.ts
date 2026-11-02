import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { AuditModule } from '../audit/audit.module';
import { EncryptionModule } from '../common/encryption/encryption.module';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import configuration from '../config/configuration';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MailModule } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SessionsModule } from '../sessions/sessions.module';
import { UsersModule } from '../users/users.module';
import { UsersIndexMigration } from '../users/users-index.migration';
import { UsersService } from '../users/users.service';
import { SubAccountsModule } from './sub-accounts.module';

// Real HTTP through the real guards, pipes and interceptors, against the real dev
// Mongo (this project's convention). Everything created here starts with PREFIX and
// is removed in afterAll.

const PREFIX = `jest-subaccounts-${Date.now()}`;
const email = (name: string) => `${PREFIX}-${name}@example.com`.toLowerCase();

// Stands in for any business module the lock should stop.
@UseGuards(JwtAuthGuard)
@Controller('lock-probe')
class LockProbeController {
  @Get()
  probe() {
    return { reached: true };
  }
}

describe('Sub-accounts (real HTTP, real Mongo)', () => {
  let app: INestApplication;
  let base: string;
  let connection: Connection;
  let auth: AuthService;
  let users: UsersService;
  let jwt: JwtService;
  const sent: { to: string; token: string }[] = [];

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
    return { status: res.status, body: json, raw: text };
  }

  async function register(name: string) {
    const result = await auth.register(email(name), 'Passw0rd!23', `${name} person`, `${PREFIX}-${name}`, {});
    const decoded = jwt.decode(result.accessToken) as { sub: string; organizationId: string };
    return { token: result.accessToken, userId: decoded.sub, organizationId: decoded.organizationId };
  }

  const subForm = (name: string, extra: Record<string, unknown> = {}) => ({
    name: `${PREFIX}-${name}`,
    businessEmail: email(name),
    phoneCountryCode: '+91',
    phone: '9876543210',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    ...extra,
  });

  async function seedSubscription(organizationId: string, status: string, amount = 1200, cycle = 'yearly') {
    const db = connection;
    const plan = await db.collection('billing_plans').insertOne({ key: `${PREFIX}-${organizationId}-${status}`, name: `${PREFIX} plan`, active: false, isPublic: false });
    const price = await db.collection('billing_plan_prices').insertOne({ planId: plan.insertedId.toString(), currencyCode: 'INR', billingCycle: cycle, amount, creditsGranted: 1, effectiveFrom: new Date(), effectiveTo: null, active: false });
    await db.collection('billing_subscriptions').insertOne({
      organizationId,
      planId: plan.insertedId.toString(),
      planPriceId: price.insertedId.toString(),
      status,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      cancelAtPeriodEnd: false,
      renewalFailureCount: 0,
      createdBy: 'jest',
      createdAt: new Date(),
    });
  }

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
        MongooseModule.forRoot(uri),
        EncryptionModule,
        MailModule,
        AuditModule,
        AuthModule,
        OrganizationsModule,
        UsersModule,
        SessionsModule,
        SubAccountsModule,
      ],
      controllers: [LockProbeController],
    })
      .overrideProvider(MailService)
      .useValue({
        invitationLink: (token: string) => `http://app.test/activate?token=${encodeURIComponent(token)}`,
        sendInvitationEmail: async (to: string, _name: string, _business: string, token: string) => {
          sent.push({ to, token });
        },
        sendVerificationOtp: async () => undefined,
        sendWelcomeEmail: async () => undefined,
        sendPasswordResetOtp: async () => undefined,
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    connection = moduleRef.get(getConnectionToken());
    auth = moduleRef.get(AuthService);
    users = moduleRef.get(UsersService);
    jwt = moduleRef.get(JwtService);
  }, 60_000);

  afterAll(async () => {
    // Let fire-and-forget writes (audit entries, session touches) finish first.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const orgs = await connection.collection('organizations').find({ slug: { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } }).toArray();
    const orgIds = orgs.map((o) => o._id.toString());
    const plans = await connection.collection('billing_plans').find({ key: { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } }).toArray();
    await Promise.all([
      connection.collection('users').deleteMany({ email: { $regex: `^${PREFIX}` } }),
      connection.collection('stores').deleteMany({ organizationId: { $in: orgIds } }),
      connection.collection('audit_logs').deleteMany({ organizationId: { $in: orgIds } }),
      connection.collection('billing_subscriptions').deleteMany({ organizationId: { $in: orgIds } }),
      connection.collection('billing_plan_prices').deleteMany({ planId: { $in: plans.map((p) => p._id.toString()) } }),
      connection.collection('billing_plans').deleteMany({ key: { $regex: `^${PREFIX}` } }),
      connection.collection('organizations').deleteMany({ slug: { $regex: `^${PREFIX}` } }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.close();
  }, 30_000);

  describe('email index migration', () => {
    it('keeps logins unique while letting a member record share the address, and is safe to repeat', async () => {
      const migration = app.get(UsersIndexMigration);
      await migration.run();
      await migration.run();
      const names = (await connection.collection('users').indexes()).map((i) => i.name);
      expect(names).toEqual(expect.arrayContaining(['email_login_unique', 'email_lookup']));
      expect(names).not.toContain('email_1');

      const login = await register('index');
      await expect(users.create({ email: email('index'), name: 'dup', organizationId: login.organizationId })).rejects.toMatchObject({ code: 11000 });
      const owner = await users.findById(login.userId);
      const member = await users.createLinkedMember(owner!, login.organizationId, 'admin');
      expect(member.email).toBe(email('index'));
      expect(member.isLogin).toBe(false);
      // Everything that starts from an email finds the login, never the member record.
      expect((await users.findByEmail(email('index')))!._id.toString()).toBe(login.userId);
      await users.removeLinkedMember(login.userId, login.organizationId);
    });
  });

  describe('creating a sub-account', () => {
    it('creates an independent business, an owner with no password, and access for the Main owner only', async () => {
      const main = await register('createmain');
      const res = await call('POST', '/sub-accounts', main.token, subForm('createsub'));
      expect(res.status).toBe(201);
      expect(res.body.activationLink).toContain('/activate?token=');

      const org = await connection.collection('organizations').findOne({ slug: { $regex: `^${PREFIX}-createsub` } });
      expect(org!.parentOrganizationId).toBe(main.organizationId);
      expect(org!._id.toString()).not.toBe(main.organizationId);
      expect(org!.timezone).toBe('Asia/Kolkata');
      expect(org!.currency).toBe('INR');
      expect(await connection.collection('stores').countDocuments({ organizationId: org!._id.toString() })).toBe(1);

      const owner = await users.findByEmail(email('createsub'));
      expect(owner!.organizationId).toBe(org!._id.toString());
      expect(owner!.passwordHash).toBeUndefined();
      expect(owner!.roles).toEqual(['owner', 'admin']);
      expect(owner!.inviteTokenHash).toBeDefined();

      const member = await users.findLinkedMember(main.userId, org!._id.toString());
      expect(member!.roles).toEqual(['admin']);
      expect(member!.passwordHash).toBeUndefined();
      expect(sent.find((s) => s.to === email('createsub'))).toBeDefined();
    });

    it('refuses a duplicate email, including the Main owner’s own', async () => {
      const main = await register('dupmain');
      expect((await call('POST', '/sub-accounts', main.token, subForm('dupsub'))).status).toBe(201);
      expect((await call('POST', '/sub-accounts', main.token, subForm('dupsub2', { businessEmail: email('dupsub') }))).status).toBe(409);
      expect((await call('POST', '/sub-accounts', main.token, subForm('dupsub3', { businessEmail: email('dupmain') }))).status).toBe(409);
      // A refused create leaves no business behind.
      expect(await connection.collection('organizations').countDocuments({ slug: { $regex: `^${PREFIX}-dupsub2` } })).toBe(0);
    });

    it('checks every required field, and an email, phone, time zone and logo that are valid', async () => {
      const main = await register('validmain');
      for (const field of ['name', 'businessEmail', 'phoneCountryCode', 'phone', 'timezone', 'currency']) {
        const form: Record<string, unknown> = subForm('validsub');
        delete form[field];
        expect({ field, status: (await call('POST', '/sub-accounts', main.token, form)).status }).toEqual({ field, status: 400 });
      }
      expect((await call('POST', '/sub-accounts', main.token, subForm('v1', { businessEmail: 'nope' }))).status).toBe(400);
      expect((await call('POST', '/sub-accounts', main.token, subForm('v2', { phone: 'abc' }))).status).toBe(400);
      expect((await call('POST', '/sub-accounts', main.token, subForm('v3', { timezone: 'Mars/Olympus' }))).status).toBe(400);
      expect((await call('POST', '/sub-accounts', main.token, subForm('v4', { currency: 'ZZZ' }))).status).toBe(400);
      expect((await call('POST', '/sub-accounts', main.token, subForm('v5', { logo: 'data:image/svg+xml;base64,PHN2Zz4=' }))).status).toBe(400);
      expect((await call('POST', '/sub-accounts', main.token, subForm('v6', { organizationId: 'x' }))).status).toBe(400);
    });

    it('only a Main Account’s owner can manage: not an employee, a sub-account owner, or someone switched in', async () => {
      const main = await register('rolemain');
      await call('POST', '/sub-accounts', main.token, subForm('rolesub'));
      const org = await connection.collection('organizations').findOne({ slug: { $regex: `^${PREFIX}-rolesub` } });
      const subId = org!._id.toString();

      const employee = await users.create({ email: email('roleemp'), name: 'Employee', organizationId: main.organizationId, roles: ['admin'] });
      const { accessToken: employeeToken } = await auth.issueSessionToken(employee, {});
      expect((await call('GET', '/sub-accounts', employeeToken)).status).toBe(403);

      const invite = sent.find((s) => s.to === email('rolesub'))!;
      const { accessToken: subOwnerToken } = await auth.acceptInvitation(invite.token, 'Passw0rd!23');
      // Paid, so this checks the role rule rather than the subscription lock.
      await seedSubscription(subId, 'active');
      expect((await call('GET', '/sub-accounts', subOwnerToken)).status).toBe(403);
      expect((await call('POST', '/sub-accounts', subOwnerToken, subForm('nested'))).status).toBe(403);

      const switched = await call('POST', '/organizations/switch', main.token, { organizationId: subId });
      expect((await call('GET', '/sub-accounts', switched.body.accessToken)).status).toBe(403);
      expect((await call('GET', '/sub-accounts')).status).toBe(401);
    });
  });

  describe('invitations', () => {
    it('activates once, then the password logs in; an expired link does not work', async () => {
      const main = await register('invitemain');
      await call('POST', '/sub-accounts', main.token, subForm('invitesub'));
      const { token } = sent.find((s) => s.to === email('invitesub'))!;

      // Cannot sign in before activating.
      expect((await call('POST', '/auth/login', undefined, { email: email('invitesub'), password: 'Passw0rd!23' })).status).toBe(401);

      const shown = await call('POST', '/auth/invitation/verify', undefined, { token });
      expect(shown.status).toBe(201);
      expect(shown.body.email).toBe(email('invitesub'));
      expect(shown.raw).not.toContain('Hash');

      expect((await call('POST', '/auth/invitation/accept', undefined, { token, password: 'short' })).status).toBe(400);
      const accepted = await call('POST', '/auth/invitation/accept', undefined, { token, password: 'Passw0rd!23' });
      expect(accepted.status).toBe(201);
      expect((await call('GET', '/users/me', accepted.body.accessToken)).body.email).toBe(email('invitesub'));

      // Single use.
      expect((await call('POST', '/auth/invitation/accept', undefined, { token, password: 'Another!234' })).status).toBe(400);
      expect((await call('POST', '/auth/login', undefined, { email: email('invitesub'), password: 'Passw0rd!23' })).body.status).toBe('ok');

      const owner = await users.findByEmail(email('invitesub'));
      expect(owner!.passwordHash).not.toContain('Passw0rd');
      expect(owner!.emailVerified).toBe(true);
    });

    it('refuses an expired link, and a new invitation replaces the old one', async () => {
      const main = await register('expiremain');
      const created = await call('POST', '/sub-accounts', main.token, subForm('expiresub'));
      const first = sent.find((s) => s.to === email('expiresub'))!.token;

      expect((await call('POST', `/sub-accounts/${created.body.id}/resend-invitation`, main.token)).status).toBe(201);
      const second = [...sent].reverse().find((s) => s.to === email('expiresub'))!.token;
      expect(second).not.toBe(first);
      expect((await call('POST', '/auth/invitation/verify', undefined, { token: first })).status).toBe(400);

      await connection.collection('users').updateOne({ email: email('expiresub'), isLogin: { $ne: false } }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
      expect((await call('POST', '/auth/invitation/accept', undefined, { token: second, password: 'Passw0rd!23' })).status).toBe(400);
    });
  });

  describe('switching accounts', () => {
    async function setup(label: string) {
      const main = await register(`${label}main`);
      const created = await call('POST', '/sub-accounts', main.token, subForm(`${label}sub`));
      await seedSubscription(created.body.id, 'active');
      const switched = await call('POST', '/organizations/switch', main.token, { organizationId: created.body.id });
      return { main, subId: created.body.id as string, subToken: switched.body.accessToken as string, status: switched.status };
    }

    it('enters without logging in again, with that business’s role, and the session’s expiry unchanged', async () => {
      const { main, subId, subToken, status } = await setup('sw');
      expect(status).toBe(201);
      const claims = jwt.decode(subToken) as any;
      const original = jwt.decode(main.token) as any;
      expect(claims.organizationId).toBe(subId);
      expect(claims.sub).not.toBe(main.userId);
      expect(claims.loginUserId).toBe(main.userId);
      expect(claims.jti).toBe(original.jti);
      expect(claims.exp).toBeLessThanOrEqual(original.exp);
      expect(claims.roles).toEqual(['admin']);

      const me = await call('GET', '/users/me', subToken);
      expect(me.status).toBe(200);
      expect(me.body.organizationId).toBe(subId);
      expect(me.body.linkedFromMain).toBe(true);
      expect(me.body.email).toBe(email('swmain'));

      const accounts = await call('GET', '/organizations/accounts', subToken);
      expect(accounts.body.currentOrganizationId).toBe(subId);
      expect(accounts.body.homeOrganizationId).toBe(main.organizationId);
      expect(accounts.body.canManageSubAccounts).toBe(false);
      expect(accounts.body.accounts.map((a: any) => a.accountType)).toEqual(['main', 'sub']);

      const back = await call('POST', '/organizations/switch', subToken, { organizationId: main.organizationId });
      const backClaims = jwt.decode(back.body.accessToken) as any;
      expect(backClaims.sub).toBe(main.userId);
      expect(backClaims.loginUserId).toBeUndefined();
      expect((await call('GET', '/organizations/accounts', back.body.accessToken)).body.canManageSubAccounts).toBe(true);
    });

    it('never enters a business the login has no access to', async () => {
      const a = await setup('deny');
      const stranger = await register('denystranger');
      const strangerSub = await call('POST', '/sub-accounts', stranger.token, subForm('denystrangersub'));

      expect((await call('POST', '/organizations/switch', a.main.token, { organizationId: stranger.organizationId })).status).toBe(403);
      expect((await call('POST', '/organizations/switch', a.main.token, { organizationId: strangerSub.body.id })).status).toBe(403);
      expect((await call('POST', '/organizations/switch', stranger.token, { organizationId: a.subId })).status).toBe(403);
      expect((await call('POST', '/organizations/switch', a.main.token, { organizationId: 'not-an-id' })).status).toBe(400);

      // A Main employee has no access unless it is granted.
      const employee = await users.create({ email: email('denyemp'), name: 'Employee', organizationId: a.main.organizationId, roles: ['admin'] });
      const { accessToken } = await auth.issueSessionToken(employee, {});
      expect((await call('POST', '/organizations/switch', accessToken, { organizationId: a.subId })).status).toBe(403);
      const list = await call('GET', '/organizations/accounts', accessToken);
      expect(list.body.accounts.map((x: any) => x.id)).toEqual([a.main.organizationId]);

      // Listing shows only what this login can enter.
      const strangerList = await call('GET', '/organizations/accounts', stranger.token);
      expect(strangerList.body.accounts.map((x: any) => x.id)).not.toContain(a.subId);
    });

    it('rejects forged tokens that claim a business or login they don’t have', async () => {
      const a = await setup('forge');
      const stranger = await register('forgestranger');
      const claims = jwt.decode(a.subToken) as any;
      const sign = (payload: Record<string, unknown>) => jwt.sign(payload, { expiresIn: '5m' });
      const { exp: _exp, iat: _iat, ...base2 } = claims;

      // A member record's id without its login.
      const { loginUserId: _drop, ...noLogin } = base2;
      expect((await call('GET', '/users/me', sign(noLogin))).status).toBe(401);
      // Someone else's login named on this member record.
      expect((await call('GET', '/users/me', sign({ ...base2, loginUserId: stranger.userId }))).status).toBe(401);
      // A valid token with another business written into it: the server decides the business.
      const strangerClaims = jwt.decode(stranger.token) as any;
      const { exp: _e, iat: _i, ...strangerBase } = strangerClaims;
      const forged = await call('GET', '/users/me', sign({ ...strangerBase, organizationId: a.subId }));
      expect(forged.body.organizationId).toBe(stranger.organizationId);
    });

    it('stops working at once when access, the login or the session goes', async () => {
      const a = await setup('revoke');
      expect((await call('GET', '/users/me', a.subToken)).status).toBe(200);

      // Signing out from inside the sub-account ends the login's session.
      const second = await auth.issueSessionToken((await users.findById(a.main.userId))!, {});
      const secondSub = await call('POST', '/organizations/switch', second.accessToken, { organizationId: a.subId });
      expect((await call('POST', '/auth/logout', secondSub.body.accessToken)).status).toBe(201);
      expect((await call('GET', '/users/me', secondSub.body.accessToken)).status).toBe(401);
      expect((await call('GET', '/users/me', second.accessToken)).status).toBe(401);

      // Sessions and security belong to the login, whichever business is open.
      const sessions = await call('GET', '/sessions', a.subToken);
      expect(sessions.status).toBe(200);
      expect(sessions.body.some((s: any) => s.current)).toBe(true);

      await users.removeLinkedMember(a.main.userId, a.subId);
      expect((await call('GET', '/users/me', a.subToken)).status).toBe(401);
      expect((await call('POST', '/organizations/switch', a.main.token, { organizationId: a.subId })).status).toBe(403);
    });

    it('suspending or archiving blocks everyone inside; lifting it restores access', async () => {
      const a = await setup('status');
      expect((await call('POST', `/sub-accounts/${a.subId}/status`, a.main.token, { status: 'suspended' })).status).toBe(201);
      expect((await call('GET', '/users/me', a.subToken)).status).toBe(401);
      expect((await call('POST', '/organizations/switch', a.main.token, { organizationId: a.subId })).status).toBe(403);
      // The Main Account itself is not affected.
      expect((await call('GET', '/users/me', a.main.token)).status).toBe(200);

      expect((await call('POST', `/sub-accounts/${a.subId}/status`, a.main.token, { status: 'active' })).status).toBe(201);
      expect((await call('GET', '/users/me', a.subToken)).status).toBe(200);

      // A suspension by the HaiVE platform isn't the Main Account's to lift or sidestep.
      await connection.collection('organizations').updateOne({ parentOrganizationId: a.main.organizationId }, { $set: { status: 'suspended', suspendedByParent: false } });
      expect((await call('POST', `/sub-accounts/${a.subId}/status`, a.main.token, { status: 'active' })).status).toBe(403);
      const form = (await call('GET', `/sub-accounts/${a.subId}`, a.main.token)).body;
      expect((await call('POST', `/sub-accounts/${a.subId}/archive`, a.main.token, { confirmName: form.name })).status).toBe(403);
      await connection.collection('organizations').updateOne({ parentOrganizationId: a.main.organizationId }, { $set: { status: 'active' } });

      expect((await call('POST', `/sub-accounts/${a.subId}/archive`, a.main.token, { confirmName: 'wrong' })).status).toBe(400);
      expect((await call('POST', `/sub-accounts/${a.subId}/archive`, a.main.token, { confirmName: form.name })).status).toBe(201);
      expect((await call('GET', '/users/me', a.subToken)).status).toBe(401);
      const sub = await connection.collection('billing_subscriptions').findOne({ organizationId: a.subId });
      expect(sub!.cancelAtPeriodEnd).toBe(true);
      expect((await call('GET', '/organizations/accounts', a.main.token)).body.accounts.map((x: any) => x.id)).not.toContain(a.subId);

      expect((await call('POST', `/sub-accounts/${a.subId}/restore`, a.main.token)).status).toBe(201);
      expect((await call('GET', '/users/me', a.subToken)).status).toBe(200);
    });
  });

  describe('isolation between businesses', () => {
    it('a Main Account can’t read or change another Main Account’s sub-account at all', async () => {
      const owner = await register('isoowner');
      const other = await register('isoother');
      const { body } = await call('POST', '/sub-accounts', owner.token, subForm('isosub'));
      for (const path of ['', '/users', '/billing', '/integrations', '/activity', '/grantable-employees']) {
        expect({ path, status: (await call('GET', `/sub-accounts/${body.id}${path}`, other.token)).status }).toEqual({ path, status: 404 });
      }
      expect((await call('PATCH', `/sub-accounts/${body.id}`, other.token, { name: 'hacked' })).status).toBe(404);
      expect((await call('POST', `/sub-accounts/${body.id}/status`, other.token, { status: 'suspended' })).status).toBe(404);
      expect((await call('POST', `/sub-accounts/${body.id}/restore`, other.token)).status).toBe(404);
      expect((await call('GET', '/sub-accounts', other.token)).body.subAccounts).toEqual([]);
    });

    it('per-person data is separate: the same person is a different user in each business', async () => {
      const main = await register('perperson');
      const { body } = await call('POST', '/sub-accounts', main.token, subForm('perpersonsub'));
      await seedSubscription(body.id, 'active');
      const switched = await call('POST', '/organizations/switch', main.token, { organizationId: body.id });
      const memberId = (jwt.decode(switched.body.accessToken) as any).sub;
      expect(memberId).not.toBe(main.userId);

      // A mailbox connected in the Main Account is keyed to the login's id, so a query
      // by the id acting in the sub-account can't find it; and the reverse.
      const mailboxes = connection.collection('outlook_connections');
      const a = await mailboxes.insertOne({ userId: main.userId, organizationId: main.organizationId, email: email('box'), isActive: false });
      expect(await mailboxes.countDocuments({ userId: memberId })).toBe(0);
      expect(await mailboxes.countDocuments({ userId: main.userId })).toBe(1);
      await mailboxes.deleteOne({ _id: a.insertedId });
    });

    it('the Main owner stays out of the sub-account’s team lists, and its admins can’t remove them', async () => {
      const main = await register('teammain');
      const { body } = await call('POST', '/sub-accounts', main.token, subForm('teamsub'));
      const { token: invite } = sent.find((s) => s.to === email('teamsub'))!;
      const { accessToken: subOwner } = await auth.acceptInvitation(invite, 'Passw0rd!23');
      await seedSubscription(body.id, 'active');
      const memberId = (await users.findLinkedMember(main.userId, body.id))!._id.toString();

      expect((await users.findAll(body.id)).map((u) => u._id.toString())).not.toContain(memberId);
      expect((await users.findTeamRoster(body.id)).map((u) => u._id.toString())).not.toContain(memberId);
      const store = (await connection.collection('stores').findOne({ organizationId: body.id }))!;
      expect(await users.findIdsByOrgAndStore(body.id, store._id.toString())).not.toContain(memberId);

      // The Users page shows them, labelled.
      const list = await call('GET', '/users', subOwner);
      const row = list.body.find((u: any) => u.id === memberId);
      expect(row.linkedFromMain).toBe(true);
      expect(row.name).toBe('teammain person');

      expect((await call('PATCH', `/users/${memberId}`, subOwner, { active: false })).status).toBe(403);
      expect((await call('DELETE', `/users/${memberId}`, subOwner)).status).toBe(403);
    });

    it('a sub-account’s own employee sees only that business', async () => {
      const main = await register('empmain');
      const { body } = await call('POST', '/sub-accounts', main.token, subForm('empsub'));
      const { token: invite } = sent.find((s) => s.to === email('empsub'))!;
      const { accessToken: subOwner } = await auth.acceptInvitation(invite, 'Passw0rd!23');
      await seedSubscription(body.id, 'active');

      const created = await call('POST', '/users', subOwner, { email: email('empperson'), name: 'New Person', role: 'admin', sendInvite: true });
      expect(created.status).toBe(201);
      expect(created.body.tempPassword).toBeUndefined();
      expect(created.body.user.organizationId).toBe(body.id);
      const { token } = [...sent].reverse().find((s) => s.to === email('empperson'))!;
      const { accessToken } = await auth.acceptInvitation(token, 'Passw0rd!23');

      const accounts = await call('GET', '/organizations/accounts', accessToken);
      expect(accounts.body.accounts.map((a: any) => a.id)).toEqual([body.id]);
      expect(accounts.body.canManageSubAccounts).toBe(false);
      expect((await call('POST', '/organizations/switch', accessToken, { organizationId: main.organizationId })).status).toBe(403);
      expect((await call('GET', '/organizations/me', accessToken)).body._id).toBe(body.id);
    });

    it('grants a Main employee access only when asked, and it can be removed; the owner’s cannot', async () => {
      const main = await register('grantmain');
      const { body } = await call('POST', '/sub-accounts', main.token, subForm('grantsub'));
      await seedSubscription(body.id, 'active');
      const employee = await users.create({ email: email('grantemp'), name: 'Employee', organizationId: main.organizationId, roles: ['admin'] });
      const { accessToken } = await auth.issueSessionToken(employee, {});
      const employeeId = employee._id.toString();

      expect((await call('GET', `/sub-accounts/${body.id}/grantable-employees`, main.token)).body.map((e: any) => e.id)).toEqual([employeeId]);
      expect((await call('POST', `/sub-accounts/${body.id}/access`, main.token, { userId: employeeId, role: 'admin' })).status).toBe(201);
      const entered = await call('POST', '/organizations/switch', accessToken, { organizationId: body.id });
      expect(entered.status).toBe(201);

      const stranger = await register('grantstranger');
      expect((await call('POST', `/sub-accounts/${body.id}/access`, main.token, { userId: stranger.userId, role: 'admin' })).status).toBe(400);

      expect((await call('DELETE', `/sub-accounts/${body.id}/access/${main.userId}`, main.token)).status).toBe(400);
      expect((await call('DELETE', `/sub-accounts/${body.id}/access/${employeeId}`, main.token)).status).toBe(200);
      expect((await call('GET', '/users/me', entered.body.accessToken)).status).toBe(401);

      // Deleting a login takes all their member records with it.
      await users.createLinkedMember(employee, body.id, 'admin');
      await users.deleteByAdmin(employeeId, main.organizationId);
      expect(await users.findLinkedMember(employeeId, body.id)).toBeNull();
    });
  });

  describe('dashboard and read-only views', () => {
    it('reports status and billing, never credentials or secrets', async () => {
      const main = await register('dashmain');
      const paid = await call('POST', '/sub-accounts', main.token, subForm('dashpaid'));
      const unpaid = await call('POST', '/sub-accounts', main.token, subForm('dashunpaid'));
      await seedSubscription(paid.body.id, 'active', 1200, 'yearly');

      await connection.collection('integration_credentials').insertOne({ organizationId: paid.body.id, provider: 'plivo', credentialsEncrypted: 'SECRET-VALUE' });
      await connection.collection('payment_methods').insertOne({ organizationId: paid.body.id, gatewayCustomerId: 'SECRET-CUSTOMER', gatewayTokenIdEncrypted: 'SECRET-TOKEN', cardNetwork: 'visa', cardLast4: '4242', isDefault: true });

      const list = await call('GET', '/sub-accounts', main.token);
      expect(list.body.overview).toMatchObject({ total: 2, active: 2, inactive: 0, pendingSubscriptions: 1, monthlyRevenue: [{ currency: 'INR', amount: 100 }] });
      const row = list.body.subAccounts.find((s: any) => s.id === paid.body.id);
      expect(row).toMatchObject({ status: 'active', userCount: 1, ownerActivated: false, ownerName: expect.any(String) });
      expect(row.billing).toMatchObject({ status: 'active', amount: 1200, cycle: 'yearly' });
      expect(list.body.subAccounts.find((s: any) => s.id === unpaid.body.id).billing.status).toBe('none');

      const everything = [
        list.raw,
        (await call('GET', `/sub-accounts/${paid.body.id}`, main.token)).raw,
        (await call('GET', `/sub-accounts/${paid.body.id}/users`, main.token)).raw,
        (await call('GET', `/sub-accounts/${paid.body.id}/billing`, main.token)).raw,
        (await call('GET', `/sub-accounts/${paid.body.id}/integrations`, main.token)).raw,
        (await call('GET', `/sub-accounts/${paid.body.id}/activity`, main.token)).raw,
        (await call('GET', '/organizations/accounts', main.token)).raw,
      ].join('\n');
      for (const forbidden of ['SECRET-', 'passwordHash', 'inviteTokenHash', 'credentialsEncrypted', 'gatewayToken', '"jti"', 'twoFactor']) {
        expect({ forbidden, found: everything.includes(forbidden) }).toEqual({ forbidden, found: false });
      }
      const billing = (await call('GET', `/sub-accounts/${paid.body.id}/billing`, main.token)).body;
      expect(billing.paymentMethods[0]).toMatchObject({ cardNetwork: 'visa', last4: '4242', isDefault: true });
      const integrations = (await call('GET', `/sub-accounts/${paid.body.id}/integrations`, main.token)).body;
      expect(integrations.connections.map((c: any) => c.provider)).toEqual(['plivo']);

      await connection.collection('integration_credentials').deleteMany({ organizationId: paid.body.id });
      await connection.collection('payment_methods').deleteMany({ organizationId: paid.body.id });
    });

    it('edits details without touching the owner’s login', async () => {
      const main = await register('editmain');
      const { body } = await call('POST', '/sub-accounts', main.token, subForm('editsub'));
      const res = await call('PATCH', `/sub-accounts/${body.id}`, main.token, { city: 'Chennai', website: 'example.com', timezone: 'Asia/Dubai' });
      expect(res.status).toBe(200);
      expect(res.body.profile.city).toBe('Chennai');
      expect(res.body.timezone).toBe('Asia/Dubai');
      expect((await call('PATCH', `/sub-accounts/${body.id}`, main.token, { businessEmail: 'x@y.io' })).status).toBe(400);
      expect((await call('PATCH', `/sub-accounts/${body.id}`, main.token, { timezone: 'Nope/Nowhere' })).status).toBe(400);
    });
  });

  describe('the subscription lock', () => {
    it('a sub-account with no live subscription reaches only billing and account settings', async () => {
      const main = await register('lockmain');
      const { body } = await call('POST', '/sub-accounts', main.token, subForm('locksub'));
      const { token: invite } = sent.find((s) => s.to === email('locksub'))!;
      const { accessToken: subOwner } = await auth.acceptInvitation(invite, 'Passw0rd!23');

      const blocked = await call('GET', '/lock-probe', subOwner);
      expect(blocked.status).toBe(402);
      expect(blocked.body.code).toBe('SUBSCRIPTION_REQUIRED');
      expect((await call('GET', '/users/me', subOwner)).status).toBe(200);
      expect((await call('GET', '/organizations/stores', subOwner)).status).toBe(200);
      expect((await call('GET', '/sessions', subOwner)).status).toBe(200);
      expect((await call('GET', '/organizations/accounts', subOwner)).body.locked).toBe(true);

      // Whoever enters it sees the same lock, and the Main Account itself isn't locked.
      const switched = await call('POST', '/organizations/switch', main.token, { organizationId: body.id });
      expect((await call('GET', '/lock-probe', switched.body.accessToken)).status).toBe(402);
      expect((await call('GET', '/lock-probe', main.token)).status).toBe(200);
      expect((await call('GET', '/organizations/accounts', main.token)).body.locked).toBe(false);
    });

    it('each state is decided per account: one account’s expiry never touches another', async () => {
      const main = await register('statesmain');
      const a = await call('POST', '/sub-accounts', main.token, subForm('statesa'));
      const b = await call('POST', '/sub-accounts', main.token, subForm('statesb'));
      const tokenA = (await call('POST', '/organizations/switch', main.token, { organizationId: a.body.id })).body.accessToken;
      const tokenB = (await call('POST', '/organizations/switch', main.token, { organizationId: b.body.id })).body.accessToken;

      await seedSubscription(a.body.id, 'active');
      await seedSubscription(b.body.id, 'active');
      expect((await call('GET', '/lock-probe', tokenA)).status).toBe(200);
      expect((await call('GET', '/lock-probe', tokenB)).status).toBe(200);

      const subscriptions = connection.collection('billing_subscriptions');
      for (const [status, expected] of [['past_due', 200], ['trialing', 200], ['expired', 402], ['canceled', 402]] as const) {
        await subscriptions.updateOne({ organizationId: a.body.id }, { $set: { status } });
        expect({ status, a: (await call('GET', '/lock-probe', tokenA)).status }).toEqual({ status, a: expected });
        expect((await call('GET', '/lock-probe', tokenB)).status).toBe(200);
        expect((await call('GET', '/lock-probe', main.token)).status).toBe(200);
      }

      // The Main Account having no subscription at all changes nothing for a paid sub-account.
      expect(await subscriptions.countDocuments({ organizationId: main.organizationId })).toBe(0);
      expect((await call('GET', '/lock-probe', tokenB)).status).toBe(200);
    });
  });
});
