import { RecordReader } from './adapters/task-source-adapter';
import { EodReportService } from './eod-report.service';
import { buildSections, deterministicSummary } from './eod-sections';
import { TaskQueryService } from './task-query.service';
import { DEFAULT_AUTOMATION_CONFIG } from './task-types';
import { FakeModel, matches } from './testing/fake-model';

const NOW = new Date('2026-11-24T12:30:00.000Z'); // 18:00 in Asia/Kolkata
const DATE = '2026-11-24';

class FakeReader extends RecordReader {
  data: Record<string, Record<string, unknown>[]> = {};
  async find(collection: string, filter: Record<string, unknown>) {
    return (this.data[collection] ?? []).filter((d) => matches(d, filter)) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

describe('EodReportService', () => {
  let tasks: FakeModel;
  let events: FakeModel;
  let reports: FakeModel;
  let users: FakeModel;
  let runs: FakeModel;
  let reader: FakeReader;
  let ai: { meetings: jest.Mock; summarize: jest.Mock };
  let service: EodReportService;
  let sanjay: string;

  beforeEach(async () => {
    tasks = new FakeModel();
    events = new FakeModel([], ['at']);
    reports = new FakeModel([['organizationId', 'userId', 'date']]);
    users = new FakeModel();
    runs = new FakeModel();
    reader = new FakeReader();
    ai = { meetings: jest.fn(async () => ({ connected: true, meetings: [{ title: 'Standup', start: '2026-11-24T05:00:00', end: '2026-11-24T05:15:00' }] })), summarize: jest.fn(async () => 'AI narrative.') };
    const cfg = { effectiveTimezone: async () => 'Asia/Kolkata', get: async () => ({ ...DEFAULT_AUTOMATION_CONFIG }) } as never;
    const query = new TaskQueryService(tasks as never, events as never, cfg);
    service = new EodReportService(reports as never, users as never, runs as never, query, cfg, reader, ai as never);
    for (const adapterId of ['crm', 'email']) await runs.create({ organizationId: 'org1', adapterId, status: 'ok', startedAt: new Date(NOW.getTime() - 3600_000) });
    sanjay = (await users.create({ organizationId: 'org1', email: 'sanjay@pantheras.io', name: 'Sanjay', active: true, reportingManagerId: 'mgr1' }))!._id;
    const base = { organizationId: 'org1', assignedTo: sanjay, isActive: true, sourcePlatform: 'hoops', sourceType: 'deal', priority: 'medium' };
    const earlier = new Date(NOW.getTime() - 2 * 3600_000);
    await tasks.create({ ...base, sourceRecordId: '1', title: 'Closed deal', status: 'completed', completedAt: earlier, completionEvidence: { type: 'source_status', detail: 'Deal marked won in hoops.', at: earlier } });
    await tasks.create({ ...base, sourceRecordId: '2', title: 'Overdue quote', status: 'pending', dueDate: new Date(NOW.getTime() - 86400_000), priority: 'high', sourceType: 'quote_payment' });
    await tasks.create({ ...base, sourceRecordId: '3', title: 'Reply to Asha', status: 'in_progress', sourceType: 'email_reply_owed', sourcePlatform: 'outlook' });
    await tasks.create({ ...base, sourceRecordId: '4', title: 'Waiting on legal', status: 'blocked' });
    reader.data.email_intelligence_items = [{ organizationId: 'org1', userId: sanjay, sentAt: earlier }, { organizationId: 'org1', userId: 'other', sentAt: earlier }];
    reader.data.crm_activities = [{ organizationId: 'org1', actorUserId: sanjay, kind: 'won', entity: 'deal', customerName: 'Acme', occurredAt: earlier }];
  });

  it('builds the report from tracked records only, with evidence, manager and data gaps', async () => {
    const res = await service.generateForUser('org1', sanjay, DATE, { now: NOW });
    expect(res).toMatchObject({ created: true, status: 'generated' });
    const r = reports.docs[0];
    expect(r).toMatchObject({ organizationId: 'org1', userId: sanjay, date: DATE, status: 'generated', managerId: 'mgr1', summary: 'AI narrative.', summarySource: 'ai', employeeEmail: 'sanjay@pantheras.io' });
    const s = r.sections as ReturnType<typeof buildSections>;
    expect(s.completed.map((t) => t.title)).toEqual(['Closed deal']);
    expect(s.completed[0].evidence).toMatchObject({ type: 'source_status' });
    expect(s.overdue.map((t) => t.title)).toEqual(['Overdue quote']);
    expect(s.pending.map((t) => t.title)).toEqual(['Reply to Asha']);
    expect(s.blocked.map((t) => t.title)).toEqual(['Waiting on legal']);
    expect(s.customerFollowUps).toMatchObject({ repliesSent: 1 });
    expect(s.customerFollowUps.pending.map((t) => t.title)).toEqual(['Reply to Asha']);
    expect(s.crmUpdates).toHaveLength(1);
    expect(s.meetings.items).toHaveLength(1);
    expect(s.nextDayPriorities[0].title).toBe('Overdue quote');
    expect(s.counts).toEqual({ completed: 1, pending: 1, overdue: 1, blocked: 1, awaitingVerification: 0 });
  });

  it('sends the AI only the verified sections', async () => {
    await service.generateForUser('org1', sanjay, DATE, { now: NOW });
    const [, , name, date, sections] = ai.summarize.mock.calls[0];
    expect([name, date]).toEqual(['Sanjay', DATE]);
    expect(sections.completed).toHaveLength(1);
  });

  it('never creates a second report for the same employee and day', async () => {
    await service.generateForUser('org1', sanjay, DATE, { now: NOW });
    const again = await service.generateForUser('org1', sanjay, DATE, { now: NOW });
    expect(again).toMatchObject({ created: false, status: 'already_generated' });
    expect(reports.docs).toHaveLength(1);
    expect(ai.summarize).toHaveBeenCalledTimes(1);
  });

  it('two concurrent generations produce one report', async () => {
    const [a, b] = await Promise.all([service.generateForUser('org1', sanjay, DATE, { now: NOW }), service.generateForUser('org1', sanjay, DATE, { now: NOW })]);
    expect(reports.docs).toHaveLength(1);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('falls back to a plain-facts summary when the AI is unavailable, and records calendar gaps', async () => {
    ai.summarize.mockResolvedValueOnce(null);
    ai.meetings.mockResolvedValueOnce({ connected: false, meetings: [] });
    await service.generateForUser('org1', sanjay, DATE, { now: NOW });
    const r = reports.docs[0];
    expect(r.summarySource).toBe('deterministic');
    expect(String(r.summary)).toContain('1 task(s) completed');
    expect(r.dataGaps).toEqual(expect.arrayContaining([expect.stringContaining('calendar is not connected')]));
  });

  it('flags integrations that failed recently as data gaps', async () => {
    await runs.create({ organizationId: 'org1', adapterId: 'crm', status: 'failed', startedAt: new Date(NOW.getTime() - 60_000) });
    await service.generateForUser('org1', sanjay, DATE, { now: NOW });
    expect(reports.docs[0].dataGaps).toEqual(expect.arrayContaining([expect.stringContaining('"crm" synchronization failed')]));
  });

  it('records a failure, then retries it up to the attempt limit', async () => {
    ai.meetings.mockRejectedValueOnce(new Error('boom')); // handled as a gap, not a failure
    users.docs[0].organizationId = 'elsewhere'; // makes the employee lookup fail
    const first = await service.generateForUser('org1', sanjay, DATE, { now: NOW, maxAttempts: 2 });
    expect(first.status).toBe('failed');
    expect(reports.docs[0]).toMatchObject({ status: 'failed', attempts: 1 });
    users.docs[0].organizationId = 'org1';
    const retry = await service.generateForUser('org1', sanjay, DATE, { now: NOW, maxAttempts: 2 });
    expect(retry.status).toBe('generated');
    expect(reports.docs[0]).toMatchObject({ status: 'generated', attempts: 2 });
  });

  it('gives up after maxAttempts failures', async () => {
    users.docs[0].organizationId = 'elsewhere';
    await service.generateForUser('org1', sanjay, DATE, { now: NOW, maxAttempts: 2 });
    await service.generateForUser('org1', sanjay, DATE, { now: NOW, maxAttempts: 2 });
    expect((await service.generateForUser('org1', sanjay, DATE, { now: NOW, maxAttempts: 2 })).status).toBe('gave_up');
  });

  it('retakes a report whose generator died, but not one still being generated', async () => {
    await reports.create({ organizationId: 'org1', userId: sanjay, date: DATE, timezone: 'Asia/Kolkata', status: 'generating', attempts: 1, startedAt: new Date(NOW.getTime() - 60_000) });
    expect((await service.generateForUser('org1', sanjay, DATE, { now: NOW })).status).toBe('in_progress');
    reports.docs[0].startedAt = new Date(NOW.getTime() - 60 * 60_000);
    expect((await service.generateForUser('org1', sanjay, DATE, { now: NOW })).status).toBe('generated');
  });

  it('every active team member is eligible, tracked work or not; never the owner or inactive people', async () => {
    const idle = (await users.create({ organizationId: 'org1', email: 'idle@x.io', name: 'Idle', active: true, roles: ['consultant'] }))!._id;
    await users.create({ organizationId: 'org1', email: 'owner@x.io', name: 'Owner', active: true, roles: ['owner', 'admin'] });
    const gone = (await users.create({ organizationId: 'org1', email: 'gone@x.io', name: 'Gone', active: false, roles: ['consultant'] }))!._id;
    await tasks.create({ organizationId: 'org1', assignedTo: gone, isActive: true, status: 'pending', title: 'x', sourceRecordId: '9' });
    await users.create({ organizationId: 'org2', email: 'other@x.io', name: 'Other org', active: true, roles: ['consultant'] });
    // Sanjay has no team role in this fixture but has tracked work, so he still counts.
    expect((await service.eligibleEmployees('org1', DATE)).sort()).toEqual([sanjay, idle].sort());
  });

  it('deterministic summary states only counts and names present in the sections', () => {
    const empty = buildSections({ userId: 'u', date: DATE, timezone: 'UTC', open: [], overdue: [], completed: [], counts: { open: 0, overdue: 0, completed: 0, blocked: 0, awaitingVerification: 0 } }, { meetings: { source: 'not_connected', items: [] }, repliesSent: 0, crmUpdates: [] });
    expect(deterministicSummary('Sanjay', DATE, empty)).toMatch(/Sanjay's end-of-day for 2026-11-24: 0 task\(s\) completed, 0 pending, 0 overdue\.$/);
  });

  describe('zero-activity days are reported honestly', () => {
    let idle: string;
    beforeEach(async () => {
      idle = (await users.create({ organizationId: 'org1', email: 'idle@x.io', name: 'Idle', active: true, roles: ['consultant'] }))!._id;
      ai.summarize.mockResolvedValue(null); // use the plain-facts summary so the wording is checked
      ai.meetings.mockResolvedValue({ connected: true, meetings: [] });
    });
    const report = () => reports.docs.find((r) => r.userId === idle)!;
    const sectionsOf = () => report().sections as import('./schemas/eod-report.schema').EodSections;

    it('no assigned work: a report is still generated and says so without judging productivity', async () => {
      const res = await service.generateForUser('org1', idle, DATE, { now: NOW });
      expect(res.status).toBe('generated');
      expect(sectionsOf().assessment).toMatchObject({ headline: 'no_assigned_work', assignedWork: false, completedWork: false, activityDetected: false, syncHealth: 'ok' });
      expect(String(report().summary)).toMatch(/No work is assigned to this person in the connected platforms/);
      expect(String(report().summary)).toMatch(/not a statement about their productivity/);
    });

    it('assigned but nothing verified complete is different from no work', async () => {
      await tasks.create({ organizationId: 'org1', assignedTo: idle, isActive: true, status: 'in_progress', title: 'Call back', sourceRecordId: 'z', sourcePlatform: 'hoops', sourceType: 'deal', priority: 'medium' });
      await service.generateForUser('org1', idle, DATE, { now: NOW });
      expect(sectionsOf().assessment).toMatchObject({ headline: 'no_completed_work', assignedWork: true, completedWork: false });
      expect(String(report().summary)).toMatch(/1 task\(s\) are assigned and none was completed with verified evidence/);
    });

    it('activity with no tracked tasks is called out as activity, not as nothing', async () => {
      reader.data.email_intelligence_items = [{ organizationId: 'org1', userId: idle, sentAt: new Date(NOW.getTime() - 3600_000) }];
      await service.generateForUser('org1', idle, DATE, { now: NOW });
      expect(sectionsOf().assessment).toMatchObject({ headline: 'no_assigned_work', activityDetected: true });
      expect(String(report().summary)).toMatch(/Some activity was detected today/);
    });

    it('a failed synchronization is never read as an idle employee', async () => {
      await runs.create({ organizationId: 'org1', adapterId: 'crm', status: 'failed', startedAt: new Date(NOW.getTime() - 60_000) });
      await service.generateForUser('org1', idle, DATE, { now: NOW });
      const a = sectionsOf().assessment!;
      expect(a).toMatchObject({ headline: 'sync_unreliable', syncHealth: 'degraded' });
      expect(a.syncNotes.join(' ')).toMatch(/"crm" synchronization failed/);
      expect(String(report().summary)).toMatch(/cannot show what was assigned or done/);
      expect(String(report().summary)).not.toMatch(/No work is assigned/);
    });

    it('a source that never ran is unknown, not "no work"', async () => {
      runs.docs = runs.docs.filter((r) => r.adapterId !== 'email');
      await service.generateForUser('org1', idle, DATE, { now: NOW });
      expect(sectionsOf().assessment).toMatchObject({ headline: 'sync_unreliable', syncHealth: 'unknown' });
    });

    it('verified completed work still reads as work when a source is degraded (the failure is only noted)', async () => {
      await runs.create({ organizationId: 'org1', adapterId: 'crm', status: 'partial', startedAt: new Date(NOW.getTime() - 60_000) });
      await service.generateForUser('org1', sanjay, DATE, { now: NOW });
      const s = reports.docs.find((r) => r.userId === sanjay)!.sections as import('./schemas/eod-report.schema').EodSections;
      expect(s.assessment).toMatchObject({ headline: 'worked', syncHealth: 'degraded' });
    });

    it('a calendar that could not be read leaves activity signals partial, not "none"', async () => {
      ai.meetings.mockRejectedValue(new Error('graph down'));
      await service.generateForUser('org1', idle, DATE, { now: NOW });
      expect(sectionsOf().assessment).toMatchObject({ activitySignals: 'partial', activityDetected: false });
    });
  });
});
