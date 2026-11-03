import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { SchedulerOrchestrator } from '@nestjs/schedule/dist/scheduler.orchestrator';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { AnalyticsDashboardService } from '../analytics-dashboard/analytics-dashboard.service';
import { AI_ROLE_UNAVAILABLE_MESSAGE } from './users.service';

// People created with an AI role and their own page & action permissions, through
// the whole app: real HTTP, the real guards and interceptors, the real dev Mongo.
// Everything created here starts with PREFIX and is removed in afterAll.

const PREFIX = `jest-permissions-${Date.now()}`;
const email = (name: string) => `${PREFIX}-${name}@example.com`.toLowerCase();

describe('Per-person permissions (whole app, real HTTP, real Mongo)', () => {
  let app: INestApplication;
  let base: string;
  let db: Connection;
  let jwt: JwtService;
  let auth: AuthService;
  let ownerToken: string;
  let organizationId: string;
  let roleId: string;
  let roleSlug: string;
  let vendorId: string;

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

  /** Creates a person as the owner and signs them in with the temporary password. */
  async function person(name: string, extra: Record<string, unknown>, by = ownerToken) {
    const created = await call('POST', '/users', by, { email: email(name), name: `${name} person`, role: 'agent_user', assignedAgentId: roleSlug, ...extra });
    if (created.status !== 201) throw new Error(`creating ${name}: ${created.status} ${JSON.stringify(created.body)}`);
    const session = (await auth.login(email(name), created.body.tempPassword, {})) as { accessToken: string };
    return { id: created.body.user.id as string, token: session.accessToken };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SchedulerOrchestrator)
      .useValue({ onApplicationBootstrap() {}, beforeApplicationShutdown() {}, addCron() {}, addTimeout() {}, addInterval() {} })
      .overrideProvider(MailService)
      .useValue({
        invitationLink: (token: string) => `http://app.test/activate?token=${token}`,
        sendInvitationEmail: async () => undefined,
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

    const owner = await auth.register(email('owner'), 'Passw0rd!23', 'Owner', `${PREFIX}-org`, {});
    ownerToken = owner.accessToken;
    organizationId = (jwt.decode(ownerToken) as { organizationId: string }).organizationId;

    const role = await call('POST', '/agent-roles', ownerToken, {
      name: `${PREFIX} Sales`,
      department: 'sales',
      description: 'Follows up quotes',
      systemPrompt: 'You are a sales assistant.',
    });
    roleId = role.body._id;
    roleSlug = role.body.slug;
    await call('PATCH', `/agent-roles/${roleId}`, ownerToken, { status: 'active' });
    vendorId = (await call('POST', '/vendors', ownerToken, { name: `${PREFIX} vendor` })).body._id;
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const users = await db.collection('users').find({ email: { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } }).toArray();
    const userIds = users.map((u) => u._id.toString());
    for (const { name, type } of await db.listCollections()) {
      if (type === 'collection' && name !== 'users' && name !== 'organizations') {
        await db.collection(name).deleteMany({ $or: [{ organizationId }, { userId: { $in: userIds } }] });
      }
    }
    await db.collection('users').deleteMany({ _id: { $in: users.map((u) => new Types.ObjectId(u._id)) } });
    await db.collection('organizations').deleteMany({ _id: new Types.ObjectId(organizationId) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.close();
  }, 60_000);

  it('serves the permission catalog and the AI roles a person can be given', async () => {
    const catalog = await call('GET', '/users/permission-catalog', ownerToken);
    expect(catalog.status).toBe(200);
    expect(catalog.body.modules.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['customers', 'job_board', 'vendors', 'users']));

    const roles = await call('GET', '/users/ai-roles', ownerToken);
    expect(roles.status).toBe(200);
    const sales = roles.body.find((r: { slug: string }) => r.slug === roleSlug);
    expect(sales).toMatchObject({ accountType: 'Sales Agent', category: 'sales' });
    // An AI role without its own defaults starts people from what its features meant.
    expect(sales.defaultPermissions).toEqual(expect.arrayContaining(['dashboard:view', 'email:view', 'call_copilot:view']));
  });

  describe('someone with their own permission list', () => {
    let rep: { id: string; token: string };

    beforeAll(async () => {
      rep = await person('rep', { permissions: ['customers:view', 'vendors:edit', 'ai_agent:create'] });
    });

    it('is saved with each action’s page added, and described by their AI role', async () => {
      const me = await call('GET', '/users/me', rep.token);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ accessMode: 'permissions', accountType: 'Sales Agent', needsAiRole: false });
      expect(me.body.permissions).toEqual(['ai_agent:view', 'ai_agent:create', 'customers:view', 'vendors:view', 'vendors:edit']);
      expect(me.body.aiRole).toMatchObject({ slug: roleSlug, status: 'active' });
    });

    it.each([
      ['open Customers', 'GET', '/customers', 200],
      ['see vendors', 'GET', '/vendors', 200],
      ['add a customer', 'POST', '/customers', 403],
      ['add a vendor', 'POST', '/vendors', 403],
      ['open Finance', 'GET', '/finance/presets', 403],
      ['open the dashboard', 'GET', '/dashboard/overview', 403],
      ['open User Management', 'GET', '/users', 403],
      ['open Reporting', 'GET', '/reporting/sales', 403],
      ['use their chat attachments', 'GET', '/chat/attachments/limits', 200],
      ['see their own to-do list', 'GET', '/tasks', 200],
    ])('may %s (%s %s → %i)', async (_what, method, path, expected) => {
      const res = await call(method, path, rep.token, method === 'POST' ? { name: `${PREFIX} x` } : undefined);
      expect(res.status).toBe(expected);
      if (expected === 403) expect(res.body.message).toMatch(/permission|Insufficient role/);
    });

    it('may change a vendor (edit) but the refusal for adding one names what is missing', async () => {
      expect((await call('PATCH', `/vendors/${vendorId}`, rep.token, { contactName: 'Asha' })).status).toBe(200);
      const add = await call('POST', '/vendors', rep.token, { name: `${PREFIX} nope` });
      expect(add.body.message).toBe('You don’t have permission to add to Vendor Management. Ask an admin for access.');
    });

    it('a change by an admin applies on their very next request', async () => {
      const updated = await call('PATCH', `/users/${rep.id}`, ownerToken, { permissions: ['customers:view', 'finance:view', 'ai_agent:create'] });
      expect(updated.status).toBe(200);
      expect(updated.body.permissions).toContain('finance:view');
      expect((await call('GET', '/finance/presets', rep.token)).status).toBe(200);
      expect((await call('GET', '/vendors', rep.token)).status).toBe(403);
    });

    it('an API token they make carries exactly the same access', async () => {
      const made = await call('POST', '/api-tokens', rep.token, { name: `${PREFIX} token` });
      expect(made.status).toBe(201);
      expect((await call('GET', '/finance/presets', made.body.token)).status).toBe(200);
      expect((await call('GET', '/users', made.body.token)).status).toBe(403);
    });

    it('keeps their page access when their AI role goes back to draft, but chat stops with a clear message', async () => {
      await call('PATCH', `/agent-roles/${roleId}`, ownerToken, { status: 'draft' });
      try {
        expect((await call('GET', '/customers', rep.token)).status).toBe(200);
        const chat = await call('POST', '/chat/messages', rep.token, { message: 'hello' });
        expect(chat.status).toBe(403);
        expect(chat.body.message).toBe(AI_ROLE_UNAVAILABLE_MESSAGE);
        const listed = (await call('GET', '/users', ownerToken)).body.find((u: { id: string }) => u.id === rep.id);
        expect(listed).toMatchObject({ needsAiRole: true, aiRole: { status: 'draft' } });
      } finally {
        await call('PATCH', `/agent-roles/${roleId}`, ownerToken, { status: 'active' });
      }
    });

    it('becoming an administrator drops the list: full access', async () => {
      const admin = await person('promoted', { permissions: ['customers:view'] });
      const updated = await call('PATCH', `/users/${admin.id}`, ownerToken, { role: 'admin' });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ accessMode: 'full', accountType: 'Administrator', permissions: null });
      expect((await call('GET', '/users', admin.token)).status).toBe(200);
      const raw = await db.collection('users').findOne({ _id: new Types.ObjectId(admin.id) });
      expect(raw?.permissions).toBeUndefined();
    });

    it('a permission list is refused for an administrator', async () => {
      const res = await call('POST', '/users', ownerToken, { email: email('bad-admin'), name: 'x', role: 'admin', permissions: ['customers:view'] });
      expect(res.status).toBe(400);
    });

    it('the dashboard figures open with either Dashboard or Revenue & Analytics — the business’s only with the latter', async () => {
      const spy = jest.spyOn(app.get(AnalyticsDashboardService), 'getOverview').mockResolvedValue({} as never);
      try {
        const none = await person('no-dash', { permissions: ['customers:view'] });
        const dash = await person('dash', { permissions: ['dashboard:view'] });
        const analyst = await person('analyst', { permissions: ['analytics:view'] });
        expect((await call('GET', '/analytics-dashboard/overview?dateFrom=2026-11-01&dateTo=2026-11-03', none.token)).status).toBe(403);
        expect((await call('GET', '/analytics-dashboard/overview?dateFrom=2026-11-01&dateTo=2026-11-03', dash.token)).status).toBe(200);
        expect(spy.mock.calls.at(-1)?.[1]).toEqual({ level: 'user', userId: dash.id });
        expect((await call('GET', '/analytics-dashboard/overview?dateFrom=2026-11-01&dateTo=2026-11-03', analyst.token)).status).toBe(200);
        expect(spy.mock.calls.at(-1)?.[1]).toEqual({ level: 'org' });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('someone who may manage users but is not an admin', () => {
    let lead: { id: string; token: string };
    let strong: { id: string; token: string };

    beforeAll(async () => {
      lead = await person('lead', {
        permissions: ['users:view', 'users:create', 'users:edit', 'customers:view', 'customers:edit', 'ai_roles:view', 'ai_roles:edit'],
      });
      strong = await person('strong', { permissions: ['customers:view', 'finance:view'] });
    });

    it('sees the Users page and the AI roles to choose from', async () => {
      expect((await call('GET', '/users', lead.token)).status).toBe(200);
      expect((await call('GET', '/users/ai-roles', lead.token)).status).toBe(200);
    });

    it('can add a person with access they hold themselves', async () => {
      const res = await call('POST', '/users', lead.token, {
        email: email('junior'),
        name: 'Junior',
        role: 'agent_user',
        assignedAgentId: roleSlug,
        permissions: ['customers:edit'],
      });
      expect(res.status).toBe(201);
      const junior = await db.collection('users').findOne({ email: email('junior') });
      expect(junior?.permissions).toEqual(['customers:view', 'customers:edit']);

      const edit = await call('PATCH', `/users/${res.body.user.id}`, lead.token, { permissions: ['customers:view'] });
      expect(edit.status).toBe(200);
    });

    it.each([
      ['an administrator', { role: 'admin' }, 403, /Only owners and admins/],
      ['someone with access they don’t have', { role: 'agent_user', assignedAgentId: '', permissions: ['customers:view', 'finance:view'] }, 403, /Not yours to give: Finance/],
      ['someone without saying what they get', { role: 'agent_user', assignedAgentId: '' }, 400, /Choose which pages/],
    ])('cannot create %s', async (_what, body, status, message) => {
      const res = await call('POST', '/users', lead.token, {
        email: email(`try-${Math.random().toString(36).slice(2, 8)}`),
        name: 'Try',
        ...body,
        ...('assignedAgentId' in body ? { assignedAgentId: roleSlug } : {}),
      });
      expect(res.status).toBe(status);
      expect(res.body.message).toMatch(message);
    });

    it('cannot change themselves, the owner, or anyone with more access', async () => {
      const self = await call('PATCH', `/users/${lead.id}`, lead.token, { permissions: ['users:view', 'users:create', 'users:edit', 'users:delete'] });
      expect(self.status).toBe(400);
      expect(self.body.message).toMatch(/your own access/);
      const ownerId = (jwt.decode(ownerToken) as { sub: string }).sub;
      expect((await call('PATCH', `/users/${ownerId}`, lead.token, { name: 'x' })).status).toBe(403);
      const stronger = await call('PATCH', `/users/${strong.id}`, lead.token, { name: 'renamed' });
      expect(stronger.status).toBe(403);
      expect(stronger.body.message).toMatch(/access you don’t have/);
    });

    it('cannot delete anyone without the delete action', async () => {
      expect((await call('DELETE', `/users/${strong.id}`, lead.token)).status).toBe(403);
    });

    it('can change an AI role but not activate it or set it to draft without "manage"', async () => {
      expect((await call('PATCH', `/agent-roles/${roleId}`, lead.token, { description: 'Follows up every quote' })).status).toBe(200);
      const status = await call('PATCH', `/agent-roles/${roleId}`, lead.token, { status: 'draft' });
      expect(status.status).toBe(403);
      expect(status.body.message).toMatch(/activate AI roles/);
    });
  });

  describe('older accounts keep the rules they had', () => {
    it('a team member created without a list follows their AI role’s features, as before', async () => {
      const older = await person('older', {});
      const me = await call('GET', '/users/me', older.token);
      expect(me.body).toMatchObject({ accessMode: 'older', permissions: null });
      expect(me.body.olderPermissions).toEqual(expect.arrayContaining(['email:view', 'call_copilot:view']));
      // Routes nobody's role restricts stay open to them, as they were.
      expect((await call('GET', '/dashboard/overview', older.token)).status).toBe(200);
      // Admin-only pages stay closed.
      expect((await call('GET', '/vendors', older.token)).status).toBe(403);
      expect((await call('GET', '/users', older.token)).status).toBe(403);
    });

    it('the owner keeps full access', async () => {
      const me = await call('GET', '/users/me', ownerToken);
      expect(me.body).toMatchObject({ accessMode: 'full', accountType: 'Owner' });
      for (const path of ['/vendors', '/finance/presets', '/users', '/dashboard/overview']) {
        expect((await call('GET', path, ownerToken)).status).toBe(200);
      }
    });
  });
});
