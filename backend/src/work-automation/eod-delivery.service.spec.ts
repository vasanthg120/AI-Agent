import { DEFAULT_AUTOMATION_CONFIG } from './task-types';
import { EodDeliveryService, Transport } from './eod-delivery.service';
import { EodRecipientResolver } from './eod-recipient.resolver';
import { FakeModel } from './testing/fake-model';

const NOW = new Date('2026-11-24T13:00:00.000Z');

function transport(channel: Transport['channel'], outcome: () => { ok: true } | { ok: false; error: string }) {
  const calls: { to: string; from: string }[] = [];
  const t: Transport = {
    channel,
    send: async ({ to, senderUserId }) => {
      calls.push({ to, from: senderUserId });
      return outcome();
    },
  };
  return { t, calls };
}

describe('EodDeliveryService', () => {
  let deliveries: FakeModel;
  let reports: FakeModel;
  let users: FakeModel;
  let orgs: FakeModel;
  let gmail: FakeModel;
  let outlook: FakeModel;
  let admin: string;
  let cfg: typeof DEFAULT_AUTOMATION_CONFIG;
  let service: EodDeliveryService;
  let sanjay: string;
  let boss: string;
  let reportId: string;
  let report: Record<string, unknown>;

  beforeEach(async () => {
    cfg = { ...DEFAULT_AUTOMATION_CONFIG };
    deliveries = new FakeModel([['reportId', 'role']]);
    reports = new FakeModel();
    users = new FakeModel();
    orgs = new FakeModel();
    gmail = new FakeModel();
    outlook = new FakeModel();
    await orgs.create({ _id: 'org1', name: 'T Nager' });
    admin = (await users.create({ organizationId: 'org1', email: 'owner-login@t.nager.fullypromoted.in', name: 'Admin', active: true, roles: ['owner', 'admin'], isLogin: true }))!._id;
    await gmail.create({ userId: admin, email: 'enquiry@t.nager.fullypromoted.in', isActive: true, status: 'connected' });
    boss = (await users.create({ organizationId: 'org1', email: 'boss@pantheras.io', name: 'Boss', active: true }))!._id;
    sanjay = (await users.create({ organizationId: 'org1', email: 'sanjay@pantheras.io', name: 'Sanjay', active: true, reportingManagerId: boss }))!._id;
    report = (await reports.create({
      organizationId: 'org1',
      userId: sanjay,
      date: '2026-11-24',
      timezone: 'Asia/Kolkata',
      status: 'generated',
      employeeName: 'Sanjay',
      summary: 'Good day.',
      summarySource: 'ai',
      dataGaps: [],
      sections: {
        completed: [{ taskId: 't1', title: 'Closed <b>deal</b>', priority: 'high', status: 'completed', sourcePlatform: 'hoops', sourceType: 'deal', evidence: { type: 'source_status', detail: 'Deal marked won in hoops.', at: NOW } }],
        pending: [],
        overdue: [],
        blocked: [],
        awaitingVerification: [],
        meetings: { source: 'not_connected', items: [] },
        customerFollowUps: { repliesSent: 0, completed: [], pending: [] },
        crmUpdates: [],
        nextDayPriorities: [],
        counts: { completed: 1, pending: 0, overdue: 0, blocked: 0, awaitingVerification: 0 },
      },
    }))! as never;
    reportId = (report as { _id: string })._id;
    const config = { get: async () => cfg } as never;
    service = new EodDeliveryService(deliveries as never, reports as never, users as never, config, {} as never, {} as never, { get: () => 'https://haive.example' } as never, new EodRecipientResolver(users as never, orgs as never, gmail as never, outlook as never));
  });

  const enqueue = () => service.enqueue(report as never);

  it('addresses the organization admin (connected mailbox), the employee and their configured manager, one row each', async () => {
    const rows = await enqueue();
    expect(rows.map((r) => `${r.role}:${r.recipientEmail}:${r.status}`).sort()).toEqual([
      'admin:enquiry@t.nager.fullypromoted.in:pending',
      'employee:sanjay@pantheras.io:pending',
      'manager:boss@pantheras.io:pending',
    ]);
    // enqueueing again creates nothing new
    await enqueue();
    expect(deliveries.docs).toHaveLength(3);
  });

  it('invents no manager: none configured, inactive, in another organization, or self all skip the manager copy', async () => {
    for (const mutate of [
      () => delete users.docs.find((u) => u._id === sanjay)!.reportingManagerId,
      () => (users.docs.find((u) => u._id === sanjay)!.reportingManagerId = boss) && (users.docs.find((u) => u._id === boss)!.active = false),
      () => ((users.docs.find((u) => u._id === boss)!.active = true), (users.docs.find((u) => u._id === boss)!.organizationId = 'org2')),
      () => ((users.docs.find((u) => u._id === boss)!.organizationId = 'org1'), (users.docs.find((u) => u._id === sanjay)!.reportingManagerId = sanjay)),
    ]) {
      deliveries.docs = [];
      mutate();
      const rows = await enqueue();
      const mgr = rows.find((r) => r.role === 'manager')!;
      expect(mgr.status).toBe('skipped');
      expect(mgr.recipientEmail).toBeUndefined();
    }
  });

  it('does not copy the manager when the organization turns that off', async () => {
    cfg.sendToManager = false;
    expect((await enqueue()).map((r) => r.role).sort()).toEqual(['admin', 'employee']);
  });

  it('sends each copy once, from the employee mailbox, through the first working channel, and logs it', async () => {
    const gmail = transport('gmail', () => ({ ok: false, error: 'Gmail is not connected' }));
    const outlook = transport('outlook', () => ({ ok: true }));
    const smtp = transport('smtp', () => ({ ok: true }));
    service.useTransports([gmail.t, outlook.t, smtp.t]);
    await enqueue();
    expect(await service.processDue('org1', NOW)).toBe(3);
    expect(outlook.calls.map((c) => c.to).sort()).toEqual(['boss@pantheras.io', 'enquiry@t.nager.fullypromoted.in', 'sanjay@pantheras.io']);
    // the admin's copy leaves the ADMIN's mailbox; the employee's and manager's leave the employee's
    expect(outlook.calls.filter((c) => c.to.startsWith('enquiry')).every((c) => c.from === admin)).toBe(true);
    expect(outlook.calls.filter((c) => !c.to.startsWith('enquiry')).every((c) => c.from === sanjay)).toBe(true);
    expect(smtp.calls).toHaveLength(0);
    const sent = deliveries.docs.filter((d) => d.status === 'sent');
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ channel: 'outlook', attempts: 1 });
    expect((sent[0].channelAttempts as { channel: string; ok: boolean }[]).map((a) => `${a.channel}:${a.ok}`)).toEqual(['gmail:false', 'outlook:true']);
    // a second pass sends nothing more: duplicate prevention
    expect(await service.processDue('org1', NOW)).toBe(0);
    expect(outlook.calls).toHaveLength(3);
  });

  it('falls back to SMTP when no connected mailbox can send', async () => {
    const smtp = transport('smtp', () => ({ ok: true }));
    service.useTransports([transport('gmail', () => ({ ok: false, error: 'x' })).t, transport('outlook', () => ({ ok: false, error: 'y' })).t, smtp.t]);
    await enqueue();
    await service.processDue('org1', NOW);
    expect(deliveries.docs.map((d) => d.channel)).toEqual(['smtp', 'smtp', 'smtp']);
  });

  it('retries a failed delivery with backoff and stops at the attempt limit', async () => {
    let ok = false;
    service.useTransports([transport('smtp', () => (ok ? { ok: true } : { ok: false, error: 'SMTP down' })).t]);
    cfg.deliveryChannels = ['smtp'];
    cfg.maxDeliveryAttempts = 3;
    await enqueue();
    expect(await service.processDue('org1', NOW)).toBe(0);
    const row = () => deliveries.docs.find((d) => d.role === 'employee')!;
    expect(row()).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining('SMTP down') });
    expect(new Date(row().nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 5 * 60_000);
    // not due yet
    expect(await service.processDue('org1', new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(row().attempts).toBe(1);
    // due: still failing, backs off further
    await service.processDue('org1', new Date(NOW.getTime() + 6 * 60_000));
    expect(row().attempts).toBe(2);
    // recovers
    ok = true;
    expect(await service.processDue('org1', new Date(NOW.getTime() + 60 * 60_000))).toBe(3);
    expect(row().status).toBe('sent');
  });

  it('gives up after the limit and an admin can reset it', async () => {
    service.useTransports([transport('smtp', () => ({ ok: false, error: 'nope' })).t]);
    cfg.deliveryChannels = ['smtp'];
    cfg.maxDeliveryAttempts = 2;
    await enqueue();
    for (let i = 0; i < 4; i += 1) await service.processDue('org1', new Date(NOW.getTime() + i * 3 * 3600_000));
    expect(deliveries.docs.every((d) => d.status === 'failed' && d.attempts === 2)).toBe(true);
    expect(deliveries.docs[0].nextAttemptAt).toBeUndefined();
    expect(await service.resetFailed('org1', reportId)).toBe(3);
    expect(deliveries.docs.every((d) => d.status === 'pending' && d.attempts === 0)).toBe(true);
    expect(await service.resetFailed('org2', reportId)).toBe(0);
  });

  it('re-checks the manager at send time and skips a copy if they changed or were deactivated', async () => {
    const smtp = transport('smtp', () => ({ ok: true }));
    service.useTransports([smtp.t]);
    cfg.deliveryChannels = ['smtp'];
    await enqueue();
    users.docs.find((u) => u._id === boss)!.active = false;
    await service.processDue('org1', NOW);
    expect(smtp.calls.map((c) => c.to).sort()).toEqual(['owner-login@t.nager.fullypromoted.in', 'sanjay@pantheras.io']);
    expect(deliveries.docs.find((d) => d.role === 'manager')).toMatchObject({ status: 'skipped', skippedReason: 'manager_changed_or_inactive' });
  });

  it('concurrent workers cannot send the same delivery twice', async () => {
    const smtp = transport('smtp', () => ({ ok: true }));
    service.useTransports([smtp.t]);
    cfg.deliveryChannels = ['smtp'];
    await enqueue();
    const id = deliveries.docs.find((d) => d.role === 'employee')!._id;
    const results = await Promise.all([service.deliver(id, NOW), service.deliver(id, NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(smtp.calls).toHaveLength(1);
  });

  it('escapes report content in the email body', async () => {
    const smtp = { calls: [] as string[] };
    service.useTransports([{ channel: 'smtp', send: async ({ content }) => (smtp.calls.push(content.html), { ok: true as const }) }]);
    cfg.deliveryChannels = ['smtp'];
    await enqueue();
    await service.processDue('org1', NOW);
    expect(smtp.calls[0]).toContain('Closed &lt;b&gt;deal&lt;/b&gt;');
    expect(smtp.calls[0]).not.toContain('<b>deal</b>');
    expect(smtp.calls[0]).toContain('Verified: Deal marked won in hoops.');
  });

  describe('organization admin recipient', () => {
    const adminRow = () => deliveries.docs.find((d) => d.role === 'admin')!;
    const channels = () => {
      const smtp = transport('smtp', () => ({ ok: true }));
      const gm = transport('gmail', () => ({ ok: true }));
      const ol = transport('outlook', () => ({ ok: true }));
      service.useTransports([gm.t, ol.t, smtp.t]);
      return { smtp, gm, ol };
    };

    it("sends Sanjay's and a second employee's reports to the same admin, from the admin's Gmail", async () => {
      const { gm } = channels();
      const ravi = (await users.create({ organizationId: 'org1', email: 'ravi@pantheras.io', name: 'Ravi', active: true }))!._id;
      const raviReport = (await reports.create({ ...(report as object), userId: ravi, employeeName: 'Ravi', _id: 'r-report' }))!;
      await enqueue();
      await service.enqueue(raviReport as never);
      await service.processDue('org1', NOW);
      const toAdmin = gm.calls.filter((c) => c.to === 'enquiry@t.nager.fullypromoted.in');
      expect(toAdmin).toHaveLength(2);
      expect(toAdmin.every((c) => c.from === admin)).toBe(true);
      expect(deliveries.docs.filter((d) => d.role === 'admin').map((d) => d.employeeId).sort()).toEqual([sanjay, ravi].sort());
    });

    it('uses the Outlook mailbox when the admin connected Outlook instead of Gmail', async () => {
      gmail.docs = [];
      await outlook.create({ userId: admin, email: 'Admin@Outlook.example', isActive: true, status: 'connected', organizationId: 'org1' });
      const { ol } = channels();
      cfg.deliveryChannels = ['outlook', 'smtp'];
      await enqueue();
      expect(adminRow()).toMatchObject({ recipientEmail: 'admin@outlook.example', recipientProvider: 'outlook' });
      await service.processDue('org1', NOW);
      expect(ol.calls.find((c) => c.to === 'admin@outlook.example')?.from).toBe(admin);
      expect(adminRow()).toMatchObject({ status: 'sent', channel: 'outlook' });
    });

    it('records the provider response; a mailbox that cannot send falls through with its error logged', async () => {
      service.useTransports([
        { channel: 'gmail', send: async ({ to }) => (to.startsWith('enquiry') ? { ok: false as const, error: '400: gmail is not connected for this user' } : { ok: true as const }) },
        { channel: 'outlook', send: async () => ({ ok: true as const, response: { sent: true, channel: 'outlook' } }) },
      ]);
      cfg.deliveryChannels = ['gmail', 'outlook'];
      await enqueue();
      await service.processDue('org1', NOW);
      expect(adminRow()).toMatchObject({ status: 'sent', channel: 'outlook', providerResponse: { sent: true, channel: 'outlook' } });
      expect((adminRow().channelAttempts as { channel: string; error?: string }[])[0]).toMatchObject({ channel: 'gmail', error: expect.stringContaining('not connected') });
    });

    it('with no admin mailbox connected it warns, and only the SMTP fallback is tried', async () => {
      gmail.docs = [];
      const { smtp, gm, ol } = channels();
      await enqueue();
      expect(adminRow()).toMatchObject({ recipientEmail: 'owner-login@t.nager.fullypromoted.in', status: 'pending', warning: expect.stringContaining('admin_mailbox_not_connected') });
      await service.processDue('org1', NOW);
      expect(smtp.calls.some((c) => c.to === 'owner-login@t.nager.fullypromoted.in')).toBe(true);
      expect(gm.calls.concat(ol.calls).some((c) => c.from === admin)).toBe(false);
      expect(adminRow()).toMatchObject({ status: 'sent', channel: 'smtp', warning: expect.stringContaining('admin_mailbox_not_connected') });
    });

    it('a mailbox that needs re-authentication is not used', async () => {
      gmail.docs[0].status = 'needs_reauth';
      await enqueue();
      expect(adminRow().recipientProvider).toBeUndefined();
      expect(adminRow().warning).toBeDefined();
    });

    it("two organizations resolve to their own admin, never each other's", async () => {
      await orgs.create({ _id: 'org2', name: 'Other' });
      const admin2 = (await users.create({ organizationId: 'org2', email: 'boss@other.example', name: 'Other Admin', active: true, roles: ['owner'] }))!._id;
      await gmail.create({ userId: admin2, email: 'enquiry@other.example', isActive: true, status: 'connected' });
      const priya = (await users.create({ organizationId: 'org2', email: 'priya@other.example', name: 'Priya', active: true }))!._id;
      const priyaReport = (await reports.create({ ...(report as object), organizationId: 'org2', userId: priya, _id: 'p-report' }))!;
      const { gm } = channels();
      await enqueue();
      await service.enqueue(priyaReport as never);
      await service.processDue('org1', NOW);
      await service.processDue('org2', NOW);
      const byEmployee = (id: string) => deliveries.docs.find((d) => d.role === 'admin' && d.employeeId === id)!;
      expect(byEmployee(sanjay)).toMatchObject({ organizationId: 'org1', recipientEmail: 'enquiry@t.nager.fullypromoted.in' });
      expect(byEmployee(priya)).toMatchObject({ organizationId: 'org2', recipientEmail: 'enquiry@other.example' });
      expect(gm.calls.filter((c) => c.to === 'enquiry@other.example').every((c) => c.from === admin2)).toBe(true);
      expect(gm.calls.filter((c) => c.to === 'enquiry@t.nager.fullypromoted.in').every((c) => c.from === admin)).toBe(true);
    });

    it('does not guess an admin: none, an inactive owner, or an owner of another organization all skip the row', async () => {
      const a = () => users.docs.find((u) => u._id === admin)!;
      for (const mutate of [() => delete a().roles, () => ((a().roles = ['owner']), (a().active = false)), () => ((a().active = true), (a().organizationId = 'org2'))]) {
        deliveries.docs = [];
        mutate();
        await enqueue();
        expect(adminRow()).toMatchObject({ status: 'skipped', skippedReason: 'no_admin_found' });
        expect(adminRow().recipientEmail).toBeUndefined();
      }
    });

    it('skips safely when the employee has no valid organization mapping', async () => {
      users.docs.find((u) => u._id === sanjay)!.organizationId = 'org9';
      await enqueue();
      expect(adminRow()).toMatchObject({ status: 'skipped', skippedReason: 'employee_not_in_organization' });
    });

    it('prefers the owner in the reporting chain, then Organization.ownerUserId, then the oldest owner login', async () => {
      const second = (await users.create({ organizationId: 'org1', email: 'second@t.nager.fullypromoted.in', name: 'Second Owner', active: true, roles: ['owner'], isLogin: true }))!._id;
      await gmail.create({ userId: second, email: 'second-mailbox@t.nager.fullypromoted.in', isActive: true, status: 'connected' });
      await enqueue();
      expect(adminRow().recipientUserId).toBe(admin);
      deliveries.docs = [];
      orgs.docs[0].ownerUserId = second;
      await enqueue();
      expect(adminRow().recipientUserId).toBe(second);
      deliveries.docs = [];
      users.docs.find((u) => u._id === sanjay)!.reportingManagerId = admin;
      await enqueue();
      expect(adminRow().recipientUserId).toBe(admin);
      // the manager is the admin: no second copy
      expect(deliveries.docs.find((d) => d.role === 'manager')).toMatchObject({ status: 'skipped', skippedReason: 'same_as_admin' });
    });

    it('re-resolves at send time: a changed admin is not sent the old report', async () => {
      const { smtp, gm } = channels();
      await enqueue();
      const second = (await users.create({ organizationId: 'org1', email: 'second@t.nager.fullypromoted.in', name: 'Second', active: true, roles: ['owner'] }))!._id;
      orgs.docs[0].ownerUserId = second;
      await service.processDue('org1', NOW);
      expect(adminRow()).toMatchObject({ status: 'skipped', skippedReason: 'admin_changed' });
      expect(gm.calls.concat(smtp.calls).some((c) => c.to.startsWith('enquiry'))).toBe(false);
    });

    it('a duplicate scheduler run does not send the admin copy twice', async () => {
      const { gm } = channels();
      for (let i = 0; i < 3; i += 1) {
        await enqueue();
        await service.processDue('org1', NOW);
      }
      expect(gm.calls.filter((c) => c.to === 'enquiry@t.nager.fullypromoted.in')).toHaveLength(1);
      expect(deliveries.docs.filter((d) => d.role === 'admin')).toHaveLength(1);
    });
  });
});
