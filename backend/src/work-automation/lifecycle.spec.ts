import { JwtPayload } from '../auth/jwt-payload.interface';
import { effectiveStatus, nextStatus } from './task-lifecycle';
import { TaskLifecycleService } from './task-lifecycle.service';
import { TaskQueryService } from './task-query.service';
import { FakeModel } from './testing/fake-model';
import { WorkAccessService } from './work-access.service';

const NOW = new Date('2026-11-24T10:00:00.000Z');

const caller = (sub: string, roles: string[] = ['consultant'], organizationId = 'org1'): JwtPayload => ({ sub, roles, organizationId, email: `${sub}@x.io` });

describe('lifecycle rules', () => {
  it('allows only defined moves', () => {
    expect(nextStatus('pending', 'start')).toBe('in_progress');
    expect(nextStatus('in_progress', 'request_verification')).toBe('awaiting_verification');
    expect(nextStatus('awaiting_verification', 'verify')).toBe('completed');
    expect(() => nextStatus('pending', 'verify')).toThrow(/can.t be moved/);
    expect(() => nextStatus('completed', 'start')).toThrow();
  });
  it('derives overdue from the due date and never for completed work', () => {
    const past = new Date(NOW.getTime() - 1000);
    expect(effectiveStatus({ status: 'pending', dueDate: past }, NOW)).toBe('overdue');
    expect(effectiveStatus({ status: 'blocked', dueDate: past }, NOW)).toBe('overdue');
    expect(effectiveStatus({ status: 'completed', dueDate: past }, NOW)).toBe('completed');
    expect(effectiveStatus({ status: 'pending' }, NOW)).toBe('pending');
  });
});

describe('TaskLifecycleService + WorkAccessService', () => {
  let tasks: FakeModel;
  let events: FakeModel;
  let service: TaskLifecycleService;
  let taskId: string;
  // boss -> lead -> sanjay ; ravi unrelated
  const people = [
    { id: 'boss', reportingManagerId: undefined },
    { id: 'lead', reportingManagerId: 'boss' },
    { id: 'sanjay', reportingManagerId: 'lead' },
    { id: 'ravi', reportingManagerId: undefined },
  ];

  beforeEach(async () => {
    tasks = new FakeModel();
    events = new FakeModel([], ['at']);
    const access = new WorkAccessService({ hierarchy: async () => people } as never);
    service = new TaskLifecycleService(tasks as never, events as never, access);
    taskId = (await tasks.create({ organizationId: 'org1', assignedTo: 'sanjay', title: 'Reply', status: 'pending', isActive: true }))!._id;
  });

  it('lets the assignee start and request verification, but never complete', async () => {
    expect((await service.act(caller('sanjay'), taskId, 'start')).status).toBe('in_progress');
    await expect(service.act(caller('sanjay'), taskId, 'request_verification')).rejects.toThrow(/note/);
    expect((await service.act(caller('sanjay'), taskId, 'request_verification', 'Sent the quote')).status).toBe('awaiting_verification');
    await expect(service.act(caller('sanjay'), taskId, 'verify', 'I did it')).rejects.toThrow(/manager/);
    expect(tasks.docs[0].status).toBe('awaiting_verification');
    expect(tasks.docs[0].completionEvidence).toBeUndefined();
  });

  it('lets a manager above (directly or not) verify, storing who and why as evidence', async () => {
    await service.act(caller('sanjay'), taskId, 'request_verification', 'Sent the quote');
    const done = await service.act(caller('boss'), taskId, 'verify', 'Checked the sent mail');
    expect(done.status).toBe('completed');
    expect(done.completionEvidence).toMatchObject({ type: 'manual_verified', verifiedBy: 'boss', detail: 'Checked the sent mail' });
    expect(events.docs.map((e) => e.type)).toEqual(['verification_requested', 'completed']);
  });

  it('refuses someone who is not in the chain, and other assignees', async () => {
    await service.act(caller('sanjay'), taskId, 'request_verification', 'x');
    await expect(service.act(caller('ravi'), taskId, 'verify', 'ok')).rejects.toThrow(/manager/);
    await expect(service.act(caller('ravi'), taskId, 'start')).rejects.toThrow();
  });

  it('lets an admin verify, and isolates organizations', async () => {
    await service.act(caller('sanjay'), taskId, 'request_verification', 'x');
    await expect(service.act(caller('admin1', ['admin'], 'org2'), taskId, 'verify', 'ok')).rejects.toThrow(/not found/i);
    expect((await service.act(caller('admin1', ['admin']), taskId, 'verify', 'ok')).status).toBe('completed');
  });

  it('a manager can send work back, and cannot verify what is not awaiting verification', async () => {
    await expect(service.act(caller('boss'), taskId, 'verify', 'ok')).rejects.toThrow(/can.t be moved/);
    await service.act(caller('sanjay'), taskId, 'request_verification', 'x');
    expect((await service.act(caller('lead'), taskId, 'reject_verification', 'Missing attachment')).status).toBe('in_progress');
  });

  it('does not act on inactive tasks', async () => {
    tasks.docs[0].isActive = false;
    await expect(service.act(caller('sanjay'), taskId, 'start')).rejects.toThrow(/not found/i);
  });

  it('access: self, subtree for managers, everyone for admins', async () => {
    const access = new WorkAccessService({ hierarchy: async () => people } as never);
    expect((await access.visibleUserIds(caller('lead'))).sort()).toEqual(['lead', 'sanjay']);
    expect((await access.visibleUserIds(caller('sanjay'))).sort()).toEqual(['sanjay']);
    expect((await access.visibleUserIds(caller('x', ['owner']))).sort()).toEqual(['boss', 'lead', 'ravi', 'sanjay']);
    expect(await access.canView(caller('ravi'), 'sanjay')).toBe(false);
    expect(await access.canVerify(caller('sanjay'), 'sanjay')).toBe(false);
  });
});

describe('TaskQueryService', () => {
  it('splits a day into open / overdue / completed with counts, in the organization timezone, scoped to the person', async () => {
    const tasks = new FakeModel();
    const events = new FakeModel([], ['at']);
    const cfg = { effectiveTimezone: async () => 'Asia/Kolkata' } as never;
    const query = new TaskQueryService(tasks as never, events as never, cfg);
    const past = new Date(NOW.getTime() - 3600_000);
    const base = { organizationId: 'org1', assignedTo: 'u1', isActive: true, sourcePlatform: 'hoops', sourceType: 'deal', priority: 'medium' };
    await tasks.create({ ...base, title: 'Late', status: 'pending', dueDate: past, sourceRecordId: '1' });
    await tasks.create({ ...base, title: 'Fine', status: 'in_progress', sourceRecordId: '2', priority: 'urgent' });
    await tasks.create({ ...base, title: 'Blocked', status: 'blocked', sourceRecordId: '3' });
    await tasks.create({ ...base, title: 'Done today', status: 'completed', completedAt: past, sourceRecordId: '4' });
    await tasks.create({ ...base, title: 'Done last week', status: 'completed', completedAt: new Date(NOW.getTime() - 7 * 86400_000), sourceRecordId: '5' });
    await tasks.create({ ...base, assignedTo: 'u2', title: 'Someone else', status: 'pending', sourceRecordId: '6' });
    await tasks.create({ ...base, title: 'Hidden', status: 'pending', isActive: false, sourceRecordId: '7' });
    const day = await query.dayView('org1', 'u1', { now: NOW });
    expect(day.date).toBe('2026-11-24');
    expect(day.overdue.map((t) => t.title)).toEqual(['Late']);
    expect(day.open.map((t) => t.title)).toEqual(['Fine', 'Blocked']);
    expect(day.completed.map((t) => t.title)).toEqual(['Done today']);
    expect(day.counts).toEqual({ open: 3, overdue: 1, completed: 1, blocked: 1, awaitingVerification: 0 });
    const team = await query.teamCounts('org1', ['u1', 'u2'], { now: NOW });
    expect(team.get('u1')).toMatchObject({ open: 3, overdue: 1, completedToday: 1 });
    expect(team.get('u2')).toMatchObject({ open: 1 });
  });
});
