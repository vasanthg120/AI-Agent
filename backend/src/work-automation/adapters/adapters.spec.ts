import { IdentityService } from '../identity.service';
import { DEFAULT_AUTOMATION_CONFIG } from '../task-types';
import { FakeModel, matches } from '../testing/fake-model';
import { CrmTaskAdapter, dealActionability, dueFromDateString, quoteBalance } from './crm-task.adapter';
import { EmailTaskAdapter } from './email-task.adapter';
import { dateOnlyDeadline, endOfBusinessDay, RecordReader } from './task-source-adapter';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

class FakeReader extends RecordReader {
  data: Record<string, Record<string, unknown>[]> = {};
  async find(collection: string, filter: Record<string, unknown>) {
    return (this.data[collection] ?? []).filter((d) => matches(d, filter)) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

describe('dealActionability: an open deal is not automatically a task', () => {
  const cfg = { staleDealDays: 7, dealCloseWindowDays: 7 };
  it('ignores a quiet deal that is recent and not near closing', () => {
    expect(dealActionability({ name: 'A', expectedClosingDate: '2026-12-30', updatedAt: ago(1) }, NOW, cfg, 'UTC')).toBeNull();
  });
  it('flags a past closing date as high priority with that due date', () => {
    const v = dealActionability({ name: 'A', expectedClosingDate: '2026-11-20' }, NOW, cfg, 'UTC');
    expect(v).toMatchObject({ reason: 'overdue_close', priority: 'high' });
    expect(v?.dueDate?.toISOString()).toBe('2026-11-20T23:59:59.999Z');
  });
  it('flags a closing date inside the window', () => {
    expect(dealActionability({ name: 'A', expectedClosingDate: '2026-11-28' }, NOW, cfg, 'UTC')).toMatchObject({ reason: 'closing_soon', priority: 'medium' });
  });
  it('flags a stale deal by idle days, using lastActivityAt before updatedAt', () => {
    expect(dealActionability({ name: 'A', lastActivityAt: ago(10), updatedAt: ago(0) }, NOW, cfg, 'UTC')).toMatchObject({ reason: 'stale' });
    expect(dealActionability({ name: 'A', lastActivityAt: ago(2), updatedAt: ago(30) }, NOW, cfg, 'UTC')).toBeNull();
  });
  it('parses date-only strings and rejects junk', () => {
    expect(dueFromDateString('nope', 'UTC')).toBeUndefined();
    expect(quoteBalance({ quoteAmount: 100, paidAmount: 150 })).toBe(0);
  });
});

describe('CrmTaskAdapter', () => {
  let reader: FakeReader;
  let identities: IdentityService;
  let users: FakeModel;
  const cfg = { ...DEFAULT_AUTOMATION_CONFIG };
  const ctx = (userId?: string) => ({ organizationId: 'org1', userId, now: NOW, config: cfg, timezone: 'UTC' });

  beforeEach(async () => {
    reader = new FakeReader();
    users = new FakeModel();
    await users.create({ organizationId: 'org1', email: 'sanjay@pantheras.io', name: 'Sanjay', active: true });
    identities = new IdentityService(new FakeModel([['organizationId', 'platform', 'externalUserId']]) as never, users as never);
  });

  it('turns actionable owned deals and due quote payments into tasks for the owner only', async () => {
    reader.data.crm_deals = [
      { _id: 'd1', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'open', ownerId: 'u1', name: 'Caps', expectedClosingDate: '2026-11-22', updatedAt: ago(1) },
      { _id: 'd2', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'open', ownerId: 'u2', name: 'Other', expectedClosingDate: '2026-11-22' },
      { _id: 'd3', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'open', ownerId: 'u1', name: 'Fine', expectedClosingDate: '2027-02-01', updatedAt: ago(1) },
      { _id: 'd4', organizationId: 'org2', sourceProvider: 'hoops', dealStatus: 'open', ownerId: 'u1', name: 'Other org', expectedClosingDate: '2026-11-22' },
      { _id: 'd5', organizationId: 'org1', sourceProvider: 'haive_native', dealStatus: 'open', ownerId: 'u1', name: 'Not enabled', expectedClosingDate: '2026-11-22' },
    ];
    reader.data.crm_quotes = [
      { _id: 'q1', organizationId: 'org1', sourceProvider: 'prospectconnect', ownerUserId: 'u1', quoteStatus: 'sent', quoteNumber: '88', quoteAmount: 1000, paidAmount: 400, currency: 'INR', dueDate: '2026-11-25' },
      { _id: 'q2', organizationId: 'org1', sourceProvider: 'prospectconnect', ownerUserId: 'u1', quoteStatus: 'draft', quoteAmount: 1000, paidAmount: 0, dueDate: '2026-11-25' },
    ];
    const res = await new CrmTaskAdapter(reader, identities).collect(ctx('u1'));
    expect(res.complete).toBe(true);
    expect(res.tasks.map((t) => `${t.sourcePlatform}:${t.sourceType}:${t.sourceRecordId}`).sort()).toEqual(['hoops:deal:d1', 'pantheras:quote_payment:q1']);
    expect(res.tasks.every((t) => t.assignedTo === 'u1' && t.state === 'open')).toBe(true);
  });

  it('records completion with evidence when a deal is won or a quote is fully paid, and withdrawal when lost', async () => {
    reader.data.crm_deals = [
      { _id: 'w', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'won', ownerId: 'u1', name: 'W', closedAt: ago(1), updatedAt: ago(1) },
      { _id: 'l', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'lost', ownerId: 'u1', name: 'L', updatedAt: ago(1) },
      { _id: 'old', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'won', ownerId: 'u1', name: 'Old', updatedAt: ago(30) },
    ];
    reader.data.crm_quotes = [{ _id: 'q', organizationId: 'org1', sourceProvider: 'hoops', ownerUserId: 'u1', quoteAmount: 500, paidAmount: 500, updatedAt: ago(1) }];
    const res = await new CrmTaskAdapter(reader, identities).collect(ctx('u1'));
    const byId = Object.fromEntries(res.tasks.map((t) => [t.sourceRecordId, t]));
    expect(Object.keys(byId).sort()).toEqual(['l', 'q', 'w']);
    expect(byId.w.closure).toMatchObject({ kind: 'completed', evidence: { type: 'source_status', sourceRef: 'w' } });
    expect(byId.q.closure).toMatchObject({ kind: 'completed', evidence: { type: 'source_event' } });
    expect(byId.l.closure).toMatchObject({ kind: 'withdrawn' });
  });

  it('assigns an unowned deal only through a verified email identity, and flags the rest as unresolved', async () => {
    reader.data.crm_deals = [
      { _id: 'e1', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'open', externalOwnerRef: 'H-1', externalOwnerLabel: 'sanjay@pantheras.io', name: 'Match', expectedClosingDate: '2026-11-22' },
      { _id: 'e2', organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'open', externalOwnerRef: 'H-2', externalOwnerLabel: 'Sanjay', name: 'Name only', expectedClosingDate: '2026-11-22' },
    ];
    const res = await new CrmTaskAdapter(reader, identities).collect(ctx());
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]).toMatchObject({ sourceRecordId: 'e1', assignedTo: users.docs[0]._id });
    expect(res.unresolved).toBe(1);
    // a name-only owner was recorded for an admin, not assigned
    expect(await identities.unresolvedCount('org1')).toBe(1);
  });

  it('reports incomplete when the source read hit its row limit', async () => {
    reader.data.crm_deals = Array.from({ length: 1000 }, (_, i) => ({ _id: `x${i}`, organizationId: 'org1', sourceProvider: 'hoops', dealStatus: 'open', ownerId: 'u1', name: 'n', updatedAt: ago(0) }));
    const res = await new CrmTaskAdapter({ find: async (c: string, f: Record<string, unknown>) => (await reader.find(c, f)) } as never, identities).collect(ctx('u1'));
    expect(res.complete).toBe(false);
  });
});

describe('EmailTaskAdapter', () => {
  const cfg = { ...DEFAULT_AUTOMATION_CONFIG };
  const ctx = (userId?: string) => ({ organizationId: 'org1', userId, now: NOW, config: cfg, timezone: 'UTC' });

  it('creates tasks only for replies genuinely owed and reminders that are due', async () => {
    const reader = new FakeReader();
    reader.data.email_intelligence_items = [
      { _id: 'm1', organizationId: 'org1', userId: 'u1', subject: 'Quote please', fromName: 'Asha', receivedAt: ago(1), expectedNextAction: 'company_reply', priority: 'high', urgency: 'medium' },
      { _id: 'm2', organizationId: 'org1', userId: 'u1', subject: 'Newsletter', receivedAt: ago(1), expectedNextAction: 'no_action_required' },
      { _id: 'm3', organizationId: 'org1', userId: 'u1', subject: 'Answered', receivedAt: ago(1), expectedNextAction: 'company_reply', sentAt: ago(0) },
      { _id: 'm4', organizationId: 'org1', userId: 'u2', subject: 'Someone else', receivedAt: ago(1), expectedNextAction: 'company_reply' },
      { _id: 'm5', organizationId: 'org1', userId: 'u1', subject: 'Too old', receivedAt: ago(40), expectedNextAction: 'company_reply' },
    ];
    reader.data.email_follow_up_reminders = [
      { _id: 'r1', organizationId: 'org1', userId: 'u1', status: 'pending', title: 'Follow up Asha', dueDate: ago(0) },
      { _id: 'r2', organizationId: 'org1', userId: 'u1', status: 'pending', title: 'Later', dueDate: new Date(NOW.getTime() + 5 * DAY) },
      { _id: 'r3', organizationId: 'org1', userId: 'u1', status: 'done', title: 'Done one', dueDate: ago(2), completedVia: 'sent', completedAt: ago(0), updatedAt: ago(0) },
      { _id: 'r4', organizationId: 'org1', userId: 'u1', status: 'dismissed', title: 'Dismissed', dueDate: ago(2), updatedAt: ago(0) },
    ];
    const res = await new EmailTaskAdapter(reader).collect(ctx('u1'));
    const open = res.tasks.filter((t) => t.state === 'open').map((t) => t.sourceRecordId).sort();
    expect(open).toEqual(['m1', 'r1']);
    const closed = Object.fromEntries(res.tasks.filter((t) => t.state === 'closed').map((t) => [t.sourceRecordId, t.closure]));
    expect(closed.m3).toMatchObject({ kind: 'completed', evidence: { type: 'source_event' } });
    expect(closed.r3).toMatchObject({ kind: 'completed', evidence: { type: 'source_status' } });
    expect(closed.r4).toMatchObject({ kind: 'withdrawn' });
    expect(res.tasks.find((t) => t.sourceRecordId === 'm1')).toMatchObject({ assignedTo: 'u1', priority: 'high', title: 'Reply to Asha: Quote please' });
  });
});

describe('date-only deadlines in the organization timezone', () => {
  it('ends the day at local midnight, not UTC midnight', () => {
    expect(dateOnlyDeadline('2026-11-24', 'UTC')?.toISOString()).toBe('2026-11-24T23:59:59.999Z');
    expect(dateOnlyDeadline('2026-11-24', 'Asia/Kolkata')?.toISOString()).toBe('2026-11-24T18:29:59.999Z'); // UTC+5:30
    expect(dateOnlyDeadline('2026-11-24', 'Australia/Sydney')?.toISOString()).toBe('2026-11-24T12:59:59.999Z'); // UTC+11 (DST)
    expect(dateOnlyDeadline('2026-11-24', 'America/Los_Angeles')?.toISOString()).toBe('2026-11-25T07:59:59.999Z'); // UTC-8
    expect(dateOnlyDeadline('2026-11-24T10:00:00Z', 'Asia/Kolkata')?.toISOString()).toBe('2026-11-24T18:29:59.999Z');
    expect(dateOnlyDeadline('not a date', 'Asia/Kolkata')).toBeUndefined();
    expect(dateOnlyDeadline(undefined, 'Asia/Kolkata')).toBeUndefined();
  });

  it('handles daylight-saving changes (New York 2026-11-01 is 25 hours long)', () => {
    expect(dateOnlyDeadline('2026-11-01', 'America/New_York')?.toISOString()).toBe('2026-11-02T04:59:59.999Z'); // UTC-5 after the change
    expect(dateOnlyDeadline('2026-03-08', 'America/New_York')?.toISOString()).toBe('2026-03-09T03:59:59.999Z'); // UTC-4 after spring forward
  });

  it('a deal due "today" in Kolkata is not overdue at 23:00 Kolkata, but is at 00:01 the next day', () => {
    const cfg = { staleDealDays: 7, dealCloseWindowDays: 7 };
    const deal = { name: 'Caps', expectedClosingDate: '2026-11-24' };
    const at2300 = new Date('2026-11-24T17:30:00.000Z'); // 23:00 IST on the 24th
    const at0001 = new Date('2026-11-24T18:31:00.000Z'); // 00:01 IST on the 25th
    expect(dealActionability(deal, at2300, cfg, 'Asia/Kolkata')?.reason).toBe('closing_soon');
    expect(dealActionability(deal, at0001, cfg, 'Asia/Kolkata')?.reason).toBe('overdue_close');
    // The old UTC reading would have called it overdue 5.5 hours too late for Kolkata, and 11 hours too early for Los Angeles.
    expect(dealActionability(deal, new Date('2026-11-24T20:00:00.000Z'), cfg, 'America/Los_Angeles')?.reason).toBe('closing_soon'); // 12:00 PST the 24th
    expect(dealActionability(deal, new Date('2026-11-25T08:30:00.000Z'), cfg, 'America/Los_Angeles')?.reason).toBe('overdue_close'); // 00:30 PST the 25th
  });

  it('end of the business day follows the organization zone', () => {
    const t = new Date('2026-11-24T20:00:00.000Z'); // 01:30 on the 25th in Kolkata, still the 24th in New York
    expect(endOfBusinessDay('Asia/Kolkata', t).toISOString()).toBe('2026-11-25T18:29:59.999Z');
    expect(endOfBusinessDay('America/New_York', t).toISOString()).toBe('2026-11-25T04:59:59.999Z');
  });
});
