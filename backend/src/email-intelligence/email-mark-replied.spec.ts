import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import { describeSyncError, EmailIntelligenceSyncService, readableSyncFailure } from './email-intelligence-sync.service';
import { EmailIntelligenceService } from './email-intelligence.service';
import { deriveRespondedInfo, deriveResponseStatus, needsResponseMatch } from './email-response-state';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';
import { EmailSyncJob, EmailSyncJobDocument, EmailSyncJobSchema } from './schemas/email-sync-job.schema';

const PREFIX = `jest-mark-replied-${Date.now()}`;

// "I already replied" (answered where HaiVE can't see it) and the mailbox's
// health in words — against a real Mongo.
describe('AI Email Inbox — "I already replied" and mailbox health (real Mongo)', () => {
  let items: Model<EmailIntelligenceItemDocument>;
  let jobs: Model<EmailSyncJobDocument>;
  let service: EmailIntelligenceService;
  let sync: EmailIntelligenceSyncService;
  const sla = { recordFirstResponse: jest.fn(async () => undefined), createOrUpdateRecordForItem: jest.fn(async () => undefined) };
  const userId = new Types.ObjectId().toString();
  const orgId = `${PREFIX}-org`;
  let seq = 0;

  const owed = async (extra: Record<string, unknown> = {}) =>
    items.create({
      organizationId: orgId,
      userId,
      mailboxEmail: 'me@example.com',
      externalMessageId: `${PREFIX}-${++seq}`,
      receivedAt: new Date(),
      subject: `Quote please ${seq}`,
      fromAddress: 'customer@acme.com',
      toAddresses: ['me@example.com'],
      bodyPreview: 'Can you quote 200 shirts?',
      isRead: false,
      importance: 'normal',
      matchConfidence: 'none',
      intent: 'quotation_request',
      priority: 'high',
      urgency: 'high',
      sentiment: 'neutral',
      recommendedAction: 'Reply with the quote',
      shouldDraft: true,
      expectedNextAction: 'company_reply',
      deterministicInput: { source: 'test' },
      result: { source: 'test' },
      ...extra,
    });

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
          { name: EmailSyncJob.name, schema: EmailSyncJobSchema },
        ]),
      ],
    }).compile();
    items = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    jobs = moduleRef.get(getModelToken(EmailSyncJob.name));
    service = new EmailIntelligenceService(
      items,
      {} as never,
      { create: jest.fn(async () => undefined) } as never,
      {} as never,
      {} as never,
      { findById: async () => null, findAll: async () => [] } as never,
      { post: jest.fn(), get: jest.fn() } as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      sla as never,
      {} as never,
    );
    sync = new EmailIntelligenceSyncService(
      {} as never,
      jobs,
      {} as never,
      {} as never,
      {} as never,
      service,
      {} as never,
      {} as never,
      { post: jest.fn(), get: jest.fn() } as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
    );
  });

  afterAll(async () => {
    await items.deleteMany({ organizationId: orgId });
    await jobs.deleteMany({ userId });
    await items.db.close();
  });

  it('marks an email replied: it leaves "Needs reply", counts as answered, and can be taken back', async () => {
    const item = await owed();
    expect(deriveResponseStatus(item)).toBe('needs_response');

    const marked = await service.markReplied(userId, item._id.toString());
    expect(deriveResponseStatus(marked)).toBe('responded');
    expect(deriveRespondedInfo(marked).respondedVia).toBe('manual');
    expect(sla.recordFirstResponse).toHaveBeenCalledWith(orgId, item._id.toString(), expect.any(Date));
    // The shared "still owed a reply" query agrees — the dashboards' missed counts use it.
    expect(await items.countDocuments({ _id: item._id, ...needsResponseMatch() })).toBe(0);

    const undone = await service.unmarkReplied(userId, item._id.toString());
    expect(deriveResponseStatus(undone)).toBe('needs_response');
    expect(await items.countDocuments({ _id: item._id, ...needsResponseMatch() })).toBe(1);
  });

  it('a reply HaiVE sent or found in Sent Items can’t be undone here', async () => {
    const found = await owed({ externalReplyDetectedAt: new Date(), replyMatchedVia: 'conversation' });
    expect(deriveRespondedInfo(found).respondedVia).toBe('outlook');
    await expect(service.unmarkReplied(userId, found._id.toString())).rejects.toThrow(BadRequestException);
    // Marking one already answered changes nothing.
    const again = await service.markReplied(userId, found._id.toString());
    expect(again.replyMatchedVia).toBe('conversation');
  });

  it('only the mailbox’s owner can mark it', async () => {
    const item = await owed();
    await expect(service.markReplied(new Types.ObjectId().toString(), item._id.toString())).rejects.toThrow();
  });

  it('mailbox health: failing since the first failure after the last success, with why in words', async () => {
    const at = (iso: string) => new Date(iso);
    await jobs.create([
      { organizationId: orgId, userId, status: 'completed', triggeredBy: 'scheduled', startedAt: at('2026-11-02T10:00:00Z'), completedAt: at('2026-11-02T10:01:00Z'), createdAt: at('2026-11-02T10:00:00Z') },
      { organizationId: orgId, userId, status: 'failed', triggeredBy: 'scheduled', startedAt: at('2026-11-02T10:30:00Z'), error: 'Request failed with status code 500', createdAt: at('2026-11-02T10:30:00Z') },
      { organizationId: orgId, userId, status: 'failed', triggeredBy: 'scheduled', startedAt: at('2026-11-02T11:00:00Z'), error: 'Request failed with status code 500', createdAt: at('2026-11-02T11:00:00Z') },
    ]);
    const health = await sync.mailboxHealth(userId);
    expect(health).toMatchObject({ status: 'failing', failedRuns: 2, failingSince: at('2026-11-02T10:30:00Z'), lastSuccessAt: at('2026-11-02T10:01:00Z') });
    expect(health.reason).toMatch(/couldn’t be read/);
  });

  it('describes sync errors in words', () => {
    expect(describeSyncError('connect ECONNREFUSED 127.0.0.1:8000')).toMatch(/isn’t running/);
    expect(describeSyncError('timeout of 90000ms exceeded')).toMatch(/took too long/);
    expect(describeSyncError('Request failed with status code 401')).toMatch(/Reconnect/);
    // A reason already written for people is kept as it is.
    expect(describeSyncError('Microsoft 365’s mail service didn’t answer for this mailbox.')).toBe('Microsoft 365’s mail service didn’t answer for this mailbox.');
  });

  it('a failed sync the person started reaches them in words, not "Internal server error"', () => {
    const fromAgent = readableSyncFailure({ message: 'Request failed with status code 503', response: { data: { detail: 'Microsoft 365’s mail service didn’t answer for this mailbox.' } } });
    expect(fromAgent).toBeInstanceOf(ServiceUnavailableException);
    expect(fromAgent.message).toBe('Microsoft 365’s mail service didn’t answer for this mailbox.');
    expect(readableSyncFailure(new Error('connect ECONNREFUSED 127.0.0.1:8000')).message).toMatch(/isn’t running/);
    const ours = new BadRequestException('Outlook is not connected.');
    expect(readableSyncFailure(ours)).toBe(ours);
  });
});
