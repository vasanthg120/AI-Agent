import { CollectContext, CollectResult, TaskSourceAdapter } from './adapters/task-source-adapter';
import { AutomationConfigService } from './automation-config.service';
import { TaskSyncService } from './task-sync.service';
import { FakeModel } from './testing/fake-model';
import { DEFAULT_AUTOMATION_CONFIG, SourceTask } from './task-types';

const NOW = new Date('2026-11-24T10:00:00.000Z');

function open(over: Partial<SourceTask> = {}): SourceTask {
  return { sourcePlatform: 'hoops', sourceType: 'deal', sourceRecordId: 'd1', assignedTo: '', title: 'Close deal: Caps', priority: 'high', dueDate: new Date('2026-11-25T23:59:59.999Z'), sourceStatus: 'open', state: 'open', ...over };
}

class StubAdapter implements TaskSourceAdapter {
  readonly sourceTypes = ['deal'];
  result: CollectResult = { tasks: [], complete: true, unresolved: 0 };
  fail?: string;
  calls: CollectContext[] = [];
  constructor(
    readonly id = 'crm',
    readonly label = 'Stub',
    readonly description = 'stub',
  ) {}
  async collect(ctx: CollectContext) {
    this.calls.push(ctx);
    if (this.fail) throw new Error(this.fail);
    return this.result;
  }
}

describe('TaskSyncService', () => {
  let tasks: FakeModel;
  let events: FakeModel;
  let runs: FakeModel;
  let state: FakeModel;
  let users: FakeModel;
  let adapter: StubAdapter;
  let service: TaskSyncService;
  let sanjay: string;
  let ravi: string;
  const configService = { get: jest.fn(async () => ({ ...DEFAULT_AUTOMATION_CONFIG })), effectiveTimezone: jest.fn(async () => 'Asia/Kolkata') } as unknown as AutomationConfigService;

  beforeEach(async () => {
    tasks = new FakeModel([['organizationId', 'sourcePlatform', 'sourceType', 'sourceRecordId']]);
    events = new FakeModel();
    runs = new FakeModel();
    state = new FakeModel([['organizationId', 'scopeKey']]);
    users = new FakeModel();
    sanjay = (await users.create({ organizationId: 'org1', email: 's@x.io', name: 'Sanjay', active: true }))!._id;
    ravi = (await users.create({ organizationId: 'org1', email: 'r@x.io', name: 'Ravi', active: true }))!._id;
    adapter = new StubAdapter();
    service = new TaskSyncService(tasks as never, events as never, runs as never, state as never, users as never, [adapter], configService);
  });

  const setResult = (t: SourceTask[], complete = true) => {
    adapter.result = { tasks: t, complete, unresolved: 0 };
  };
  const apply = (scope?: string) => service.applyBatch('org1', adapter, adapter.result, scope, 'sync:crm', NOW);

  it('is idempotent: syncing the same source twice yields one task and one creation event', async () => {
    setResult([open({ assignedTo: sanjay })]);
    expect(await apply()).toMatchObject({ created: 1, updated: 0 });
    expect(await apply()).toMatchObject({ created: 0, updated: 0 });
    expect(tasks.docs).toHaveLength(1);
    expect(events.docs.filter((e) => e.type === 'created')).toHaveLength(1);
    expect(tasks.docs[0]).toMatchObject({ organizationId: 'org1', assignedTo: sanjay, status: 'pending', isActive: true, sourcePlatform: 'hoops', sourceRecordId: 'd1' });
  });

  it('keeps source-owned fields fresh but never overwrites a status the employee set', async () => {
    setResult([open({ assignedTo: sanjay })]);
    await apply();
    tasks.docs[0].status = 'in_progress';
    setResult([open({ assignedTo: sanjay, title: 'Close deal: Caps (renamed)', priority: 'urgent' })]);
    expect(await apply()).toMatchObject({ updated: 1 });
    expect(tasks.docs[0]).toMatchObject({ title: 'Close deal: Caps (renamed)', priority: 'urgent', status: 'in_progress' });
  });

  it('completes only with source evidence and keeps that evidence', async () => {
    setResult([open({ assignedTo: sanjay })]);
    await apply();
    const at = new Date('2026-11-24T09:00:00.000Z');
    setResult([open({ assignedTo: sanjay, state: 'closed', closure: { kind: 'completed', evidence: { type: 'source_status', detail: 'Deal marked won in hoops.', at, sourceRef: 'd1' } } })]);
    expect(await apply()).toMatchObject({ completed: 1 });
    expect(tasks.docs[0]).toMatchObject({ status: 'completed', completionEvidence: { type: 'source_status', sourceRef: 'd1' } });
    expect(events.docs.some((e) => e.type === 'completed' && e.actor === 'sync:crm')).toBe(true);
    // running it again changes nothing
    expect(await apply()).toMatchObject({ completed: 0 });
  });

  it('never creates a task from closed history it never tracked', async () => {
    setResult([open({ assignedTo: sanjay, state: 'closed', closure: { kind: 'completed', evidence: { type: 'source_status', detail: 'won', at: NOW } } })]);
    await apply();
    expect(tasks.docs).toHaveLength(0);
  });

  it('reopens a source-completed task when the source shows it open again', async () => {
    setResult([open({ assignedTo: sanjay })]);
    await apply();
    setResult([open({ assignedTo: sanjay, state: 'closed', closure: { kind: 'completed', evidence: { type: 'source_status', detail: 'won', at: NOW } } })]);
    await apply();
    setResult([open({ assignedTo: sanjay })]);
    await apply();
    expect(tasks.docs[0].status).toBe('pending');
    expect(tasks.docs[0].completionEvidence).toBeUndefined();
  });

  it('keeps a person-verified completion unless the source changed afterwards', async () => {
    setResult([open({ assignedTo: sanjay })]);
    await apply();
    Object.assign(tasks.docs[0], { status: 'completed', completedAt: NOW, completionEvidence: { type: 'manual_verified', detail: 'ok', at: NOW, verifiedBy: 'boss' } });
    setResult([open({ assignedTo: sanjay, sourceUpdatedAt: new Date(NOW.getTime() - 1000) })]);
    await apply();
    expect(tasks.docs[0].status).toBe('completed');
    setResult([open({ assignedTo: sanjay, sourceUpdatedAt: new Date(NOW.getTime() + 1000) })]);
    await apply();
    expect(tasks.docs[0].status).toBe('pending');
  });

  it('deactivates what disappeared from a complete read, but not from a partial one, and keeps completed work', async () => {
    setResult([open({ assignedTo: sanjay }), open({ assignedTo: sanjay, sourceRecordId: 'd2', title: 'B' }), open({ assignedTo: sanjay, sourceRecordId: 'd3', title: 'C' })]);
    await apply();
    tasks.docs.find((t) => t.sourceRecordId === 'd3')!.status = 'completed';
    setResult([open({ assignedTo: sanjay })], false);
    expect(await apply()).toMatchObject({ deactivated: 0 });
    setResult([open({ assignedTo: sanjay })], true);
    expect(await apply()).toMatchObject({ deactivated: 1 });
    expect(tasks.docs.find((t) => t.sourceRecordId === 'd2')).toMatchObject({ isActive: false, inactiveReason: 'no_longer_actionable_in_source' });
    expect(tasks.docs.find((t) => t.sourceRecordId === 'd3')!.isActive).toBe(true);
    // and it comes back, with history, when the source lists it again
    setResult([open({ assignedTo: sanjay }), open({ assignedTo: sanjay, sourceRecordId: 'd2', title: 'B' })]);
    await apply();
    expect(tasks.docs.find((t) => t.sourceRecordId === 'd2')!.isActive).toBe(true);
    expect(events.docs.filter((e) => e.type === 'reactivated')).toHaveLength(1);
  });

  it('a one-employee sync never deactivates another employee tasks', async () => {
    setResult([open({ assignedTo: sanjay }), open({ assignedTo: ravi, sourceRecordId: 'r1' })]);
    await apply();
    setResult([open({ assignedTo: sanjay })]);
    await apply(sanjay);
    expect(tasks.docs.find((t) => t.sourceRecordId === 'r1')!.isActive).toBe(true);
  });

  it('moves a reassigned task to its new owner and records it', async () => {
    setResult([open({ assignedTo: sanjay })]);
    await apply();
    setResult([open({ assignedTo: ravi })]);
    await apply();
    expect(tasks.docs).toHaveLength(1);
    expect(tasks.docs[0].assignedTo).toBe(ravi);
    expect(events.docs.find((e) => e.type === 'reassigned')).toMatchObject({ from: sanjay, to: ravi });
  });

  it('refuses to assign to inactive people or people of another organization', async () => {
    const other = (await users.create({ organizationId: 'org2', email: 'o@x.io', name: 'Other', active: true }))!._id;
    users.docs.find((u) => u._id === ravi)!.active = false;
    setResult([open({ assignedTo: other }), open({ assignedTo: ravi, sourceRecordId: 'r1' })]);
    expect(await apply()).toMatchObject({ created: 0, skippedAssignee: 2 });
    expect(tasks.docs).toHaveLength(0);
  });

  it('claims atomically: a second claim is refused while locked and while too recent', async () => {
    expect(await service.claim('org1', 'user:a', 60_000, NOW)).toBe(true);
    expect(await service.claim('org1', 'user:a', 0, NOW)).toBe(false); // still locked
    await service.release('org1', 'user:a');
    expect(await service.claim('org1', 'user:a', 60_000, new Date(NOW.getTime() + 1000))).toBe(false); // synced a second ago
    expect(await service.claim('org1', 'user:a', 60_000, new Date(NOW.getTime() + 120_000))).toBe(true);
    expect(await service.claim('org2', 'user:a', 60_000, NOW)).toBe(true); // other org is independent
  });

  it('syncUser throttles repeat logins but a forced sync runs; a failing adapter is recorded without stopping the others', async () => {
    const good = new StubAdapter('email');
    const bad = new StubAdapter('crm');
    bad.fail = 'CRM timed out';
    service = new TaskSyncService(tasks as never, events as never, runs as never, state as never, users as never, [bad, good], configService);
    const first = await service.syncUser('org1', sanjay, 'login');
    expect(first.runs.map((r) => `${r.adapterId}:${r.status}`)).toEqual(['crm:failed', 'email:ok']);
    expect(runs.docs.find((r) => r.adapterId === 'crm')).toMatchObject({ status: 'failed', error: 'CRM timed out', userId: sanjay, trigger: 'login' });
    expect((await service.syncUser('org1', sanjay, 'login')).skipped).toBe('recently_synced');
    expect((await service.syncUser('org1', sanjay, 'manual', { force: true })).runs).toHaveLength(2);
    expect(good.calls[0]).toMatchObject({ organizationId: 'org1', userId: sanjay, timezone: 'Asia/Kolkata' });
  });

  it('does nothing when the organization turned the automation off', async () => {
    (configService.get as jest.Mock).mockResolvedValueOnce({ ...DEFAULT_AUTOMATION_CONFIG, enabled: false });
    expect(await service.syncUser('org1', sanjay, 'login')).toEqual({ skipped: 'disabled', runs: [] });
    expect(adapter.calls).toHaveLength(0);
  });
});
