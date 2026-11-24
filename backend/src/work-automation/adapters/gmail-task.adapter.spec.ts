import { DEFAULT_AUTOMATION_CONFIG } from '../task-types';
import { matches } from '../testing/fake-model';
import { GmailActionsResult, GmailActionsSource, GmailKnownThread, GmailTaskAdapter } from './gmail-task.adapter';
import { RecordReader } from './task-source-adapter';

const NOW = new Date('2026-11-24T10:00:00.000Z');

class FakeReader extends RecordReader {
  data: Record<string, Record<string, unknown>[]> = {};
  async find(collection: string, filter: Record<string, unknown>) {
    return (this.data[collection] ?? []).filter((d) => matches(d, filter)) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

class FakeGmail extends GmailActionsSource {
  calls: { userId: string; known: GmailKnownThread[]; lookback: number }[] = [];
  results: Record<string, GmailActionsResult | Error> = {};
  async actions(_org: string, userId: string, lookback: number, known: GmailKnownThread[]) {
    this.calls.push({ userId, known, lookback });
    const r = this.results[userId];
    if (r instanceof Error) throw r;
    return r ?? { connected: true, mailbox: 'x', open: [], resolved: [], classifier: 'ok', complete: true, scanned: 0 };
  }
}

describe('GmailTaskAdapter', () => {
  let reader: FakeReader;
  let gmail: FakeGmail;
  let adapter: GmailTaskAdapter;
  const ctx = (userId?: string) => ({ organizationId: 'org1', userId, now: NOW, config: { ...DEFAULT_AUTOMATION_CONFIG }, timezone: 'Asia/Kolkata' });

  beforeEach(() => {
    reader = new FakeReader();
    gmail = new FakeGmail();
    adapter = new GmailTaskAdapter(reader, gmail);
    reader.data.users = [
      { _id: 'u1', organizationId: 'org1', active: true },
      { _id: 'u2', organizationId: 'org1', active: true },
      { _id: 'u3', organizationId: 'org1', active: false },
      { _id: 'x1', organizationId: 'org2', active: true },
    ];
    reader.data.gmail_connections = [
      { userId: 'u1', isActive: true, status: 'connected' },
      { userId: 'u3', isActive: true },
      { userId: 'x1', isActive: true },
      { userId: 'u2', isActive: false },
    ];
  });

  it('only reads mailboxes of active people of this organization, assigned to the mailbox owner', async () => {
    gmail.results.u1 = {
      connected: true, mailbox: 'sanjay@pantheras.io', classifier: 'ok', complete: true, scanned: 4,
      open: [
        { threadId: 'T1', kind: 'reply_owed', messageId: 'm1', subject: 'Need a quote', counterpart: 'Asha', at: '2026-11-24T08:00:00.000Z', reason: 'asks for a quote' },
        { threadId: 'T2', kind: 'promised_followup', messageId: 'm2', subject: 'Samples', counterpart: 'Bo', at: '2026-11-23T08:00:00.000Z', reason: 'promised samples', dueHint: 'tomorrow' },
      ],
      resolved: [],
    };
    const res = await adapter.collect(ctx());
    expect(gmail.calls.map((c) => c.userId)).toEqual(['u1']); // not the inactive user, other org, or a disconnected mailbox
    expect(res.complete).toBe(true);
    expect(res.tasks).toHaveLength(2);
    expect(res.tasks[0]).toMatchObject({ sourcePlatform: 'gmail', sourceType: 'gmail_reply_owed', sourceRecordId: 'T1', assignedTo: 'u1', state: 'open', title: 'Reply to Asha: Need a quote', sourceUrl: 'https://mail.google.com/mail/u/0/#all/T1', meta: { lastMessageId: 'm1', mailbox: 'sanjay@pantheras.io' } });
    expect(res.tasks[1]).toMatchObject({ sourceType: 'gmail_promise', title: 'Follow up with Bo: Samples', priority: 'high' });
  });

  it('a person-scoped sync never touches anyone else', async () => {
    reader.data.gmail_connections.push({ userId: 'u2', isActive: true });
    await adapter.collect(ctx('u1'));
    expect(gmail.calls.map((c) => c.userId)).toEqual(['u1']);
    await adapter.collect(ctx('x1')); // belongs to another organization
    expect(gmail.calls.map((c) => c.userId)).toEqual(['u1']);
  });

  it('passes the open tasks it already tracks so the source can detect replies and skip re-classification', async () => {
    reader.data.work_tasks = [
      { organizationId: 'org1', assignedTo: 'u1', sourceType: 'gmail_reply_owed', sourceRecordId: 'T1', isActive: true, status: 'pending', meta: { lastMessageId: 'm1', lastMessageAt: '2026-11-24T08:00:00.000Z' }, description: 'asks for a quote' },
      { organizationId: 'org1', assignedTo: 'u1', sourceType: 'gmail_reply_owed', sourceRecordId: 'DONE', isActive: true, status: 'completed' },
      { organizationId: 'org1', assignedTo: 'u2', sourceType: 'gmail_reply_owed', sourceRecordId: 'OTHER', isActive: true, status: 'pending' },
    ];
    await adapter.collect(ctx());
    expect(gmail.calls[0].known).toEqual([{ threadId: 'T1', kind: 'reply_owed', lastMessageId: 'm1', lastMessageAt: '2026-11-24T08:00:00.000Z', reason: 'asks for a quote' }]);
  });

  it('turns a sent reply into completion with evidence', async () => {
    gmail.results.u1 = { connected: true, mailbox: 'm', classifier: 'ok', complete: true, scanned: 1, open: [], resolved: [{ threadId: 'T1', kind: 'reply_owed', messageId: 'm9', at: '2026-11-24T09:00:00.000Z', how: 'replied' }] };
    const res = await adapter.collect(ctx());
    expect(res.tasks[0]).toMatchObject({ state: 'closed', sourceRecordId: 'T1', closure: { kind: 'completed', evidence: { type: 'source_event', sourceRef: 'm9' } } });
  });

  it('is incomplete (so nothing is retired) when a mailbox cannot be read or the classifier was down', async () => {
    gmail.results.u1 = new Error('Gmail refused the read');
    expect((await adapter.collect(ctx())).complete).toBe(false);
    gmail.results.u1 = { connected: true, mailbox: 'm', classifier: 'unavailable', complete: false, scanned: 3, open: [], resolved: [] };
    expect((await adapter.collect(ctx())).complete).toBe(false);
  });

  it('with no Gmail connections it is simply empty', async () => {
    reader.data.gmail_connections = [];
    expect(await adapter.collect(ctx())).toEqual({ tasks: [], complete: true, unresolved: 0 });
  });
});
