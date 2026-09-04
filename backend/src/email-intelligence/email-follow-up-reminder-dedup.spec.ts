import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { EmailFollowUpReminder, EmailFollowUpReminderDocument, EmailFollowUpReminderSchema } from './schemas/email-follow-up-reminder.schema';

// Real-Mongo test for the audited duplicate-reminder bug fix: the new
// unique {organizationId, emailIntelligenceItemId, reminderType} index is
// the hard guarantee EmailIntelligenceService.createFollowUpReminder's
// findOne-then-upsert now relies on — this test exercises the index itself
// (a full EmailIntelligenceService spec would need to mock a large
// dependency graph — HttpService/python-agent, CRM, quotes, users,
// notifications, EmailSlaService — just to reach a private method; the
// index is the actual correctness guarantee regardless of any application
// bug on top of it, so that's what's verified directly here).

const TEST_PREFIX = `jest-followup-dedup-${Date.now()}`;

describe('EmailFollowUpReminder duplicate prevention (real Mongo)', () => {
  let connection: Connection;
  let model: Model<EmailFollowUpReminderDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([{ name: EmailFollowUpReminder.name, schema: EmailFollowUpReminderSchema }]),
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(EmailFollowUpReminder.name)).db;
    model = moduleRef.get(getModelToken(EmailFollowUpReminder.name));
    // The unique index is declared in code but only actually built in Mongo
    // once syncIndexes runs (a fresh collection in a shared dev DB may
    // already have it from the live app, but a fresh test DB needs this).
    await model.syncIndexes();
  });

  afterAll(async () => {
    await model.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('rejects a second .create() for the same (organizationId, emailIntelligenceItemId, reminderType)', async () => {
    const organizationId = `${TEST_PREFIX}-org`;
    const doc = {
      organizationId,
      userId: 'user-1',
      emailIntelligenceItemId: 'item-1',
      reminderType: 'post_reply',
      title: 'Follow up: test',
      dueDate: new Date(Date.now() + 3 * 86_400_000),
      status: 'pending' as const,
    };
    await model.create(doc);
    await expect(model.create(doc)).rejects.toThrow();
  });

  it('findOneAndUpdate with upsert:true — the pattern createFollowUpReminder now uses — never creates a duplicate', async () => {
    const organizationId = `${TEST_PREFIX}-upsert`;
    const filter = { organizationId, emailIntelligenceItemId: 'item-2', reminderType: 'post_reply' };
    const create = () =>
      model.findOneAndUpdate(
        filter,
        { $setOnInsert: { ...filter, userId: 'user-1', title: 'Follow up: test 2', dueDate: new Date(Date.now() + 3 * 86_400_000), status: 'pending' } },
        { upsert: true, new: true },
      );

    await create();
    await create();
    await create();

    const rows = await model.find(filter).exec();
    expect(rows).toHaveLength(1);
  });

  it('a different reminderType for the same email is a separate, allowed row', async () => {
    const organizationId = `${TEST_PREFIX}-different-type`;
    const base = { organizationId, userId: 'user-1', emailIntelligenceItemId: 'item-3', title: 'x', dueDate: new Date(), status: 'pending' as const };
    await model.create({ ...base, reminderType: 'post_reply' });
    await model.create({ ...base, reminderType: 'no_reply_detected' });
    const rows = await model.find({ organizationId, emailIntelligenceItemId: 'item-3' }).exec();
    expect(rows).toHaveLength(2);
  });
});
