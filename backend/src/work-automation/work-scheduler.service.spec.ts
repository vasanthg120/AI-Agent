import { hhmmToMinutes, minutesInZone, WorkSchedulerService } from './work-scheduler.service';
import { DEFAULT_AUTOMATION_CONFIG } from './task-types';
import { FakeModel } from './testing/fake-model';

// 2026-11-24 12:30Z is 18:00 in Asia/Kolkata (UTC+5:30) and 07:30 in Asia/Kolkata the next day is not reached.
const AT_1800_IST = new Date('2026-11-24T12:30:00.000Z');
const AT_1700_IST = new Date('2026-11-24T11:30:00.000Z');
const AT_1900_IST = new Date('2026-11-24T13:30:00.000Z');

describe('minutesInZone', () => {
  it('reads wall-clock minutes in the organization zone, not the server zone', () => {
    expect(minutesInZone('Asia/Kolkata', AT_1800_IST)).toBe(18 * 60);
    expect(minutesInZone('UTC', AT_1800_IST)).toBe(12 * 60 + 30);
    expect(minutesInZone('Australia/Sydney', AT_1800_IST)).toBe(23 * 60 + 30);
    expect(hhmmToMinutes('18:00')).toBe(1080);
  });
});

describe('WorkSchedulerService.runEodForOrganization', () => {
  let cfg: typeof DEFAULT_AUTOMATION_CONFIG;
  let claimed: Set<string>;
  let sync: { claim: jest.Mock; release: jest.Mock; syncOrganization: jest.Mock };
  let eod: { eligibleEmployees: jest.Mock; generateForUser: jest.Mock };
  let delivery: { enqueue: jest.Mock; processDue: jest.Mock };
  let scheduler: WorkSchedulerService;
  const report = (id: string) => ({ _id: id, userId: id });

  beforeEach(() => {
    cfg = { ...DEFAULT_AUTOMATION_CONFIG, eodTime: '18:00' };
    claimed = new Set();
    // First claim of a key wins; "eod" (the lock) is always free again after release.
    sync = {
      claim: jest.fn(async (_o: string, scope: string) => {
        if (scope === 'eod') return true;
        if (claimed.has(scope)) return false;
        claimed.add(scope);
        return true;
      }),
      release: jest.fn(async () => undefined),
      syncOrganization: jest.fn(async () => ({ runs: [] })),
    };
    eod = {
      eligibleEmployees: jest.fn(async () => ['u1', 'u2']),
      generateForUser: jest.fn(async (_o: string, userId: string) => ({ report: report(userId), created: true, status: 'generated' })),
    };
    delivery = { enqueue: jest.fn(async () => []), processDue: jest.fn(async () => 2) };
    const config = { get: async () => cfg, effectiveTimezone: async () => 'Asia/Kolkata' };
    scheduler = new WorkSchedulerService(new FakeModel() as never, config as never, sync as never, eod as never, delivery as never);
  });

  it('does nothing but retry deliveries before the organization EOD time', async () => {
    const res = await scheduler.runEodForOrganization('org1', { now: AT_1700_IST });
    expect(res).toMatchObject({ generated: 0, skipped: 'before_eod_time' });
    expect(eod.generateForUser).not.toHaveBeenCalled();
    expect(sync.syncOrganization).not.toHaveBeenCalled();
    expect(delivery.processDue).toHaveBeenCalled();
  });

  it('at EOD: final sync first, then one report per employee, then delivery', async () => {
    const order: string[] = [];
    sync.syncOrganization.mockImplementation(async () => (order.push('sync'), { runs: [] }));
    eod.generateForUser.mockImplementation(async (_o: string, u: string) => (order.push(`gen:${u}`), { report: report(u), created: true, status: 'generated' }));
    delivery.processDue.mockImplementation(async () => (order.push('deliver'), 2));
    const res = await scheduler.runEodForOrganization('org1', { now: AT_1800_IST });
    expect(order).toEqual(['sync', 'gen:u1', 'gen:u2', 'deliver']);
    expect(res).toMatchObject({ generated: 2, delivered: 2 });
    expect(delivery.enqueue).toHaveBeenCalledTimes(2);
    expect(sync.syncOrganization).toHaveBeenCalledWith('org1', 'eod', expect.anything());
    // on time: not flagged as missed
    expect(eod.generateForUser.mock.calls[0][3]).toMatchObject({ wasMissed: false, trigger: 'schedule' });
  });

  it('recovers after a missed run: late ticks still generate, flagged as missed', async () => {
    await scheduler.runEodForOrganization('org1', { now: AT_1900_IST });
    expect(eod.generateForUser.mock.calls[0][3]).toMatchObject({ wasMissed: true });
  });

  it('the next tick resumes: the final sync is not repeated and finished reports are not regenerated', async () => {
    await scheduler.runEodForOrganization('org1', { now: AT_1800_IST });
    eod.generateForUser.mockImplementation(async (_o: string, u: string) => ({ report: report(u), created: false, status: 'already_generated' }));
    const res = await scheduler.runEodForOrganization('org1', { now: new Date(AT_1800_IST.getTime() + 10 * 60_000) });
    expect(sync.syncOrganization).toHaveBeenCalledTimes(1);
    expect(res.generated).toBe(0);
    // delivery rows are (idempotently) ensured for reports generated before a crash
    expect(delivery.enqueue).toHaveBeenCalledTimes(4);
  });

  it('skips a disabled organization entirely', async () => {
    cfg.enabled = false;
    expect(await scheduler.runEodForOrganization('org1', { now: AT_1800_IST })).toMatchObject({ skipped: 'disabled' });
    expect(eod.eligibleEmployees).not.toHaveBeenCalled();
  });

  it('a failing employee report does not block the others, and nothing is enqueued for it', async () => {
    eod.generateForUser.mockImplementation(async (_o: string, u: string) => (u === 'u1' ? { report: null, created: false, status: 'failed' } : { report: report(u), created: true, status: 'generated' }));
    const res = await scheduler.runEodForOrganization('org1', { now: AT_1800_IST });
    expect(res.generated).toBe(1);
    expect(delivery.enqueue).toHaveBeenCalledTimes(1);
  });

  it('refuses a second overlapping run of the same organization', async () => {
    sync.claim.mockImplementation(async (_o: string, scope: string) => scope !== 'eod');
    expect(await scheduler.runEodForOrganization('org1', { now: AT_1800_IST })).toMatchObject({ skipped: 'already_running' });
    expect(eod.generateForUser).not.toHaveBeenCalled();
  });

  it('a manual run ignores the time of day and is marked manual', async () => {
    await scheduler.runEodForOrganization('org1', { now: AT_1700_IST, force: true });
    expect(eod.generateForUser.mock.calls[0][3]).toMatchObject({ trigger: 'manual', wasMissed: false });
  });

  it('runs on the organization day in its own timezone (Sydney 23:30 on the 24th)', async () => {
    const config = { get: async () => ({ ...cfg, eodTime: '23:00' }), effectiveTimezone: async () => 'Australia/Sydney' };
    const sydney = new WorkSchedulerService(new FakeModel() as never, config as never, sync as never, eod as never, delivery as never);
    await sydney.runEodForOrganization('org1', { now: AT_1800_IST });
    expect(eod.generateForUser.mock.calls[0][2]).toBe('2026-11-24');
  });
});
