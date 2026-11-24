// End-to-end check of the automatic To-Do & EOD system against a REAL MongoDB
// (a throwaway database, dropped afterwards) with the real Nest dependency graph:
// seeded CRM deals / quotes / email items -> sync -> tasks -> lifecycle -> EOD
// report -> deliveries. Only the outside world is replaced: python-agent (AI
// summary, calendar) and the mail transports.
//
// Skipped automatically when no local MongoDB answers.

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';

const TEST_DB = `haive_workauto_it_${process.pid}`;
const baseUri = (process.env.MONGO_URI ?? 'mongodb://localhost:27017/agent').replace(/\/[^/?]*(\?.*)?$/, '');

async function mongoUp(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mongoose = require('mongoose') as typeof import('mongoose');
  try {
    const c = await mongoose.createConnection(`${baseUri}/${TEST_DB}`, { serverSelectionTimeoutMS: 2500 }).asPromise();
    await c.close();
    return true;
  } catch {
    return false;
  }
}

describe('work-automation (integration, real MongoDB)', () => {
  let app: INestApplication | undefined;
  let conn: Connection;
  let skip = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: Record<string, any> = {};
  const org = new Types.ObjectId().toString();
  let sanjay: string;
  let boss: string;
  const NOW = new Date();

  beforeAll(async () => {
    if (!(await mongoUp())) {
      skip = true;
      return;
    }
    process.env.MONGO_URI = `${baseUri}/${TEST_DB}`;
    process.env.SMTP_HOST = '';
    process.env.JWT_SECRET ??= 'integration-test-secret';
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../app.module') as typeof import('../app.module');
    const { EodAiClient } = require('./eod-ai.client') as typeof import('./eod-ai.client');
    const { getConnectionToken } = require('@nestjs/mongoose') as typeof import('@nestjs/mongoose');
    const { TaskSyncService } = require('./task-sync.service') as typeof import('./task-sync.service');
    const { TaskQueryService } = require('./task-query.service') as typeof import('./task-query.service');
    const { TaskLifecycleService } = require('./task-lifecycle.service') as typeof import('./task-lifecycle.service');
    const { EodReportService } = require('./eod-report.service') as typeof import('./eod-report.service');
    const { EodDeliveryService } = require('./eod-delivery.service') as typeof import('./eod-delivery.service');
    const { WorkSchedulerService } = require('./work-scheduler.service') as typeof import('./work-scheduler.service');
    const { IdentityService } = require('./identity.service') as typeof import('./identity.service');
    const { WorkAccessService } = require('./work-access.service') as typeof import('./work-access.service');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EodAiClient)
      .useValue({
        meetings: async () => ({ connected: true, meetings: [{ title: 'Standup', start: '2026-01-01T05:00:00', end: '2026-01-01T05:15:00' }] }),
        summarize: async () => 'Narrative from verified records.',
        sendMail: async () => undefined,
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    conn = app.get(getConnectionToken());
    svc = {
      sync: app.get(TaskSyncService),
      query: app.get(TaskQueryService),
      lifecycle: app.get(TaskLifecycleService),
      eod: app.get(EodReportService),
      delivery: app.get(EodDeliveryService),
      scheduler: app.get(WorkSchedulerService),
      identity: app.get(IdentityService),
      access: app.get(WorkAccessService),
    };

    const users = conn.collection('users');
    boss = (await users.insertOne({ organizationId: org, email: 'boss@pantheras.io', name: 'Boss', roles: ['manager'], active: true, isLogin: true })).insertedId.toString();
    sanjay = (await users.insertOne({ organizationId: org, email: 'sanjay@pantheras.io', name: 'Sanjay', roles: ['consultant'], active: true, isLogin: true, reportingManagerId: boss })).insertedId.toString();

    const day = 24 * 3600_000;
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    await conn.collection('crm_deals').insertMany([
      { organizationId: org, sourceProvider: 'hoops', dealStatus: 'open', ownerId: sanjay, name: 'Caps order', expectedClosingDate: ymd(new Date(NOW.getTime() - 2 * day)), updatedAt: NOW },
      { organizationId: org, sourceProvider: 'hoops', dealStatus: 'open', externalOwnerRef: 'H-7', externalOwnerLabel: 'sanjay@pantheras.io', name: 'Unowned but verifiable', expectedClosingDate: ymd(new Date(NOW.getTime() - 1 * day)), updatedAt: NOW },
      { organizationId: org, sourceProvider: 'hoops', dealStatus: 'open', externalOwnerRef: 'H-8', externalOwnerLabel: 'Sanjay', name: 'Name only', expectedClosingDate: ymd(new Date(NOW.getTime() - 1 * day)), updatedAt: NOW },
      { organizationId: new Types.ObjectId().toString(), sourceProvider: 'hoops', dealStatus: 'open', ownerId: sanjay, name: 'Other org deal', expectedClosingDate: ymd(new Date(NOW.getTime() - 1 * day)) },
    ]);
    await conn.collection('email_intelligence_items').insertOne({
      organizationId: org, userId: sanjay, mailboxEmail: 'sanjay@pantheras.io', externalMessageId: 'm1', subject: 'Need a quote', fromName: 'Asha', fromAddress: 'asha@x.io',
      receivedAt: new Date(NOW.getTime() - 3600_000), expectedNextAction: 'company_reply', priority: 'high', urgency: 'medium', status: 'pending', shouldDraft: true,
    });
  }, 120_000);

  afterAll(async () => {
    if (conn) await conn.dropDatabase().catch(() => undefined);
    if (app) await app.close();
  });

  const guard = (fn: () => Promise<void>) => async () => {
    if (skip) return;
    await fn();
  };

  it('collects work from CRM and email for the right employee, idempotently, and flags the unverifiable owner', guard(async () => {
    const first = await svc.sync.syncUser(org, sanjay, 'manual', { force: true });
    expect(first.runs.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
    const tasks = await conn.collection('work_tasks').find({ organizationId: org }).toArray();
    expect(tasks.map((t) => t.title).sort()).toEqual(['Close deal: Need a quote'.replace('Close deal: ', 'Reply to Asha: '), 'Update or close deal: Caps order', 'Update or close deal: Unowned but verifiable'].sort());
    expect(tasks.every((t) => t.assignedTo === sanjay && t.organizationId === org)).toBe(true);

    const again = await svc.sync.syncUser(org, sanjay, 'manual', { force: true });
    expect(again.runs.every((r: { counts?: { created: number } }) => r.counts?.created === 0)).toBe(true);
    expect(await conn.collection('work_tasks').countDocuments({ organizationId: org })).toBe(3);

    const unresolved = await svc.identity.list(org, 'unresolved');
    expect(unresolved.map((i: { externalUserId: string }) => i.externalUserId)).toEqual(['H-8']);
    const linked = await conn.collection('work_external_identities').findOne({ organizationId: org, externalUserId: 'H-7' });
    expect(linked).toMatchObject({ status: 'linked', userId: sanjay, matchMethod: 'email' });
  }));

  it('records completion only from source evidence, then reflects it in the day view', guard(async () => {
    await conn.collection('crm_deals').updateOne({ organizationId: org, name: 'Caps order' }, { $set: { dealStatus: 'won', closedAt: new Date(), updatedAt: new Date() } });
    await svc.sync.syncUser(org, sanjay, 'manual', { force: true });
    const done = await conn.collection('work_tasks').findOne({ organizationId: org, title: 'Update or close deal: Caps order' });
    expect(done).toMatchObject({ status: 'completed', completionEvidence: { type: 'source_status' } });
    const day = await svc.query.dayView(org, sanjay);
    expect(day.completed.map((t: { title: string }) => t.title)).toEqual(['Update or close deal: Caps order']);
    expect(day.counts.open).toBe(2);
  }));

  it('lets an employee request verification and only the manager verify it', guard(async () => {
    const t = await conn.collection('work_tasks').findOne({ organizationId: org, sourceType: 'email_reply_owed' });
    const id = t!._id.toString();
    const employee = { sub: sanjay, organizationId: org, roles: ['consultant'], email: 'sanjay@pantheras.io' };
    const manager = { sub: boss, organizationId: org, roles: ['manager'], email: 'boss@pantheras.io' };
    await svc.lifecycle.act(employee, id, 'request_verification', 'Replied by phone');
    await expect(svc.lifecycle.act(employee, id, 'verify', 'trust me')).rejects.toThrow();
    const verified = await svc.lifecycle.act(manager, id, 'verify', 'Confirmed with customer');
    expect(verified.status).toBe('completed');
    expect(JSON.parse(JSON.stringify(verified.completionEvidence))).toMatchObject({ type: 'manual_verified', verifiedBy: boss });
    const events = await conn.collection('work_task_events').find({ taskId: id }).toArray();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['created', 'verification_requested', 'completed']));
  }));

  it('generates one EOD per eligible employee per day (including a zero-assignment one) and delivers exactly once', guard(async () => {
    const sent: { to: string; from: string; channel: string }[] = [];
    svc.delivery.useTransports([
      { channel: 'gmail', send: async () => ({ ok: false, error: 'Gmail is not connected' }) },
      { channel: 'outlook', send: async ({ to, senderUserId }: { to: string; senderUserId: string }) => (sent.push({ to, from: senderUserId, channel: 'outlook' }), { ok: true }) },
      { channel: 'smtp', send: async () => ({ ok: false, error: 'unused' }) },
    ]);
    const result = await svc.scheduler.runEodForOrganization(org, { force: true });
    // Sanjay (tracked work) and Boss (a manager with nothing assigned) both get a report.
    expect(result.generated).toBe(2);
    expect(await conn.collection('work_eod_reports').countDocuments({ organizationId: org })).toBe(2);

    const report = await conn.collection('work_eod_reports').findOne({ organizationId: org, userId: sanjay });
    expect(report).toMatchObject({ status: 'generated', managerId: boss, summary: 'Narrative from verified records.' });
    expect(report!.sections.completed.map((c: { title: string }) => c.title).sort()).toEqual(['Reply to Asha: Need a quote', 'Update or close deal: Caps order']);
    expect(report!.sections.completed.every((c: { evidence?: unknown }) => !!c.evidence)).toBe(true);
    expect(report!.sections.assessment).toMatchObject({ headline: 'worked', syncHealth: 'ok' });

    // The zero-assignment employee: a real report that says so and does not read as an idle person.
    const empty = await conn.collection('work_eod_reports').findOne({ organizationId: org, userId: boss });
    expect(empty!.sections.assessment).toMatchObject({ headline: 'no_assigned_work', assignedWork: false, completedWork: false, syncHealth: 'ok' });
    expect(empty!.sections.counts).toEqual({ completed: 0, pending: 0, overdue: 0, blocked: 0, awaitingVerification: 0 });

    // Sanjay's copy goes to him and to Boss; Boss's own copy goes to Boss only (nobody above him).
    const pairs = sent.map((s) => `${s.from === sanjay ? 'sanjay' : 'boss'}->${s.to}`).sort();
    expect(pairs).toEqual(['boss->boss@pantheras.io', 'sanjay->boss@pantheras.io', 'sanjay->sanjay@pantheras.io']);

    // Running again changes nothing: no new report, no second email.
    const again = await svc.scheduler.runEodForOrganization(org, { force: true });
    expect(again.generated).toBe(0);
    expect(sent).toHaveLength(3);
    expect(await conn.collection('work_eod_reports').countDocuments({ organizationId: org })).toBe(2);
    const deliveries = await conn.collection('work_eod_deliveries').find({ organizationId: org }).toArray();
    expect(deliveries.filter((d) => d.status === 'sent')).toHaveLength(3);
    expect(deliveries.find((d) => d.employeeId === boss && d.role === 'manager')).toMatchObject({ status: 'skipped', skippedReason: 'no_manager_configured' });
  }));

  it('keeps organizations apart', guard(async () => {
    const otherOrg = new Types.ObjectId().toString();
    expect(await svc.query.dayView(otherOrg, sanjay)).toMatchObject({ counts: { open: 0, completed: 0 } });
    expect(await svc.access.canView({ sub: 'x', organizationId: otherOrg, roles: ['admin'], email: 'a@b.c' }, sanjay)).toBe(false);
  }));

  it('rejects reporting-manager loops through the real user service', guard(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { UsersService } = require('../users/users.service') as typeof import('../users/users.service');
    const users = app!.get(UsersService);
    await expect(users.assertValidReportingManager(org, boss, sanjay)).rejects.toThrow(/loop/);
    await expect(users.assertValidReportingManager(org, sanjay, boss)).resolves.toBeUndefined();
  }));
});
