import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import { EmailIntelligenceService } from './email-intelligence.service';
import { classifyEmailDeterministically } from './email-preclassification.util';
import { deriveResponseStatus, needsResponseMatch } from './email-response-state';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';

const SYSTEM = { systemSenders: ['team@pantheras.io'] };
const rule = (from: string, subject: string, preview = '') => classifyEmailDeterministically({ from, subject, preview }, SYSTEM)?.ruleName ?? null;

// Automated mail kept landing in "Needs Response" (seen 2026-11-14): Porter
// receipts, Exchange relay reports, HaiVE's own reports, Microsoft marketing —
// all stored while the AI had no credits, and an email the AI can't read was
// assumed to be a customer waiting.
describe('AI Email Inbox — automated mail never waits for a reply', () => {
  describe('the rules (the mail that was in the inbox)', () => {
    it('recognises receipts, robots and HaiVE’s own mail', () => {
      expect(rule('MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@fullypromoted.in', 'Relayed: Thank you for reaching out to Fully Promoted T. Nagar!')).toBe('receipt');
      expect(rule('postmaster@ithought.co.in', 'Delivered: Wishing You the Best for Your Event!')).toBe('bounce');
      expect(rule('someone@customer.com', 'Read: BTL Caps- Quotation')).toBe('receipt');
      expect(rule('no-reply@porter.in', 'Receipt for completed order CRN838746333584')).toBe('no_reply');
      expect(rule('noreply@communication.porter.in', 'Wish you knew it sooner, but we do House shifting between cities')).toBe('no_reply');
      expect(rule('microsoftcopilotupdates@microsoft.com', 'Start your PowerPoint presentation with less effort')).toBe('no_reply');
      expect(rule('team@pantheras.io', 'Morning briefing generated late')).toBe('system');
      expect(rule('padma@gmail.com', 'Tentatively Accepted: Mahi hospital- Merchandise Meeting')).toBe('meeting_response');
      expect(rule('padma@gmail.com', 'Declined: Merchandise Meeting')).toBe('meeting_response');
      expect(rule('HaiVE <TEAM@pantheras.io>', 'Fully Promoted T.Nagar — Main Store — End-of-Day Report')).toBe('system');
    });

    it('leaves real people and leads alone', () => {
      expect(rule('swetha@gmail.com', 'Need 200 polos with our logo')).toBeNull();
      // A customer's marketing team is exactly who orders promotional products.
      expect(rule('marketing@acme.com', 'T-shirts for our launch event')).toBeNull();
      // Website forms send from no-reply with the customer inside: a lead, left to the AI.
      expect(rule('noreply@website.com', 'New Website Enquiry | Dentist | ID:2164106')).toBeNull();
      expect(rule('no-reply@forms.example.com', 'New submission', 'Name: Priya — please send a quote for 50 caps')).toBeNull();
      // A customer proposing another time is asking for something.
      expect(rule('padma@gmail.com', 'New Time Proposed: Merchandise Meeting')).toBeNull();
      // Words inside a name are not robots.
      expect(rule('newsom@acme.com', 'Order follow-up')).toBeNull();
      // Without the server's own address configured, nothing is called HaiVE's.
      expect(classifyEmailDeterministically({ from: 'team@pantheras.io', subject: 'Morning briefing generated late', preview: '' })).toBeNull();
    });
  });

  describe('mail already stored (real Mongo)', () => {
    let items: Model<EmailIntelligenceItemDocument>;
    let service: EmailIntelligenceService;
    const userId = new Types.ObjectId().toString();
    const orgId = `jest-automated-${Date.now()}-org`;
    let seq = 0;

    const stored = (from: string, subject: string, extra: Record<string, unknown> = {}) =>
      items.create({
        organizationId: orgId,
        userId,
        mailboxEmail: 'enquiry@example.com',
        externalMessageId: `${orgId}-${++seq}`,
        receivedAt: new Date(Date.now() - seq * 60_000),
        subject,
        fromAddress: from,
        toAddresses: ['enquiry@example.com'],
        bodyPreview: '',
        isRead: false,
        importance: 'normal',
        matchConfidence: 'none',
        intent: 'existing_customer',
        priority: 'medium',
        urgency: 'medium',
        sentiment: 'neutral',
        recommendedAction: 'Reply to this email.',
        shouldDraft: false,
        fromRole: 'customer',
        expectedNextAction: 'company_reply',
        deterministicInput: { skippedLlmCall: true, reasonForSkip: 'AI analysis unavailable' },
        result: { source: 'test' },
        ...extra,
      });

    beforeAll(async () => {
      const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
      if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
      const moduleRef = await Test.createTestingModule({
        imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema }])],
      }).compile();
      items = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
      const config = { get: (key: string) => ({ 'mail.from': 'HaiVE <team@pantheras.io>', 'mail.user': 'team@pantheras.io' })[key] };
      service = new EmailIntelligenceService(
        items,
        {} as never,
        { create: jest.fn(async () => undefined) } as never,
        {} as never,
        {} as never,
        { findById: async () => null, findAll: async () => [] } as never,
        { post: jest.fn(), get: jest.fn() } as never,
        { sign: () => 'token' } as never,
        config as never,
        {} as never,
        {} as never,
      );
    });

    afterAll(async () => {
      await items.deleteMany({ organizationId: orgId });
      await items.db.close();
    });

    it('moves unread automated mail out of Needs Response and keeps everything else', async () => {
      const unread = { analysisState: 'pending', analysisAttempts: 1, analysisError: 'AI credits are used up' };
      const receipt = await stored('no-reply@porter.in', 'Receipt for completed order CRN1', unread);
      const report = await stored('team@pantheras.io', 'End-of-Day Report', unread);
      const customer = await stored('swetha@gmail.com', 'Need 200 polos', unread);
      // Read by the AI, which judged it to need an answer: a no-reply sender alone doesn't overrule that…
      const aiNoReply = await stored('noreply@hoops.example', 'Customer approved', { deterministicInput: { source: 'ai' } });
      // …but a delivery receipt does.
      const aiReceipt = await stored('someone@customer.com', 'Delivered: Quote 4536', { deterministicInput: { source: 'ai' } });

      expect(await service.quietAutomatedMail(userId)).toBe(3);

      const after = async (doc: EmailIntelligenceItemDocument) => (await items.findById(doc._id).exec())!;
      for (const quiet of [receipt, report, aiReceipt]) {
        const item = await after(quiet);
        expect(deriveResponseStatus(item)).toBe('resolved');
        expect(item.aiStatus).toBe('no_reply_needed');
      }
      // Unread junk is no longer queued for an AI reading (no credits spent on it).
      const receiptAfter = await after(receipt);
      expect(receiptAfter.analysisState).toBeUndefined();
      expect(receiptAfter.reason).toMatch(/no-reply/);
      expect((await after(report)).reason).toMatch(/HaiVE’s own/);

      expect(deriveResponseStatus(await after(customer))).toBe('needs_response');
      expect((await after(customer)).analysisState).toBe('pending');
      expect(deriveResponseStatus(await after(aiNoReply))).toBe('needs_response');
      expect(await items.countDocuments({ userId, ...needsResponseMatch() })).toBe(2);

      // Running again changes nothing.
      expect(await service.quietAutomatedMail(userId)).toBe(0);
    });

    it('a new automated email is stored as needing no reply, without calling the AI', async () => {
      const callAnalyze = jest.spyOn(service as unknown as { callAnalyze: () => Promise<unknown> }, 'callAnalyze');
      const item = await service.analyzeAndCreate(
        orgId,
        userId,
        'enquiry@example.com',
        {
          id: `${orgId}-new-1`,
          subject: 'Relayed: Thank you for reaching out',
          from: 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@example.com',
          to: ['enquiry@example.com'],
          receivedAt: new Date().toISOString(),
          preview: 'Delivery to these recipients or groups is complete',
          isRead: false,
          importance: 'normal',
        } as never,
        {
          exactEmails: new Set(),
          domains: new Set(),
          businessNamesForFuzzy: [],
          emailToGroupKey: new Map(),
          domainToGroupKey: new Map(),
          groups: new Map(),
        } as never,
      );
      expect(callAnalyze).not.toHaveBeenCalled();
      expect(deriveResponseStatus(item!)).toBe('resolved');
    });

    it('a waiting website enquiry learns where its reply goes (the customer in Reply-To)', async () => {
      const enquiry = await stored('suresh@forms.example.in', 'New Website Enquiry | Dentist | ID:2164106', { deterministicInput: { source: 'ai' } });
      await service.applyMailboxStates(userId, [{ id: enquiry.externalMessageId, state: 'present', isRead: true, replyTo: ['swetha@gmail.com'] }]);
      const after = (await items.findById(enquiry._id).exec())!;
      expect(after.replyToAddresses).toEqual(['swetha@gmail.com']);
      expect(after.isRead).toBe(true);
      // Nothing said about Reply-To leaves it as it was.
      await service.applyMailboxStates(userId, [{ id: enquiry.externalMessageId, state: 'present', isRead: false, replyTo: [] }]);
      expect((await items.findById(enquiry._id).exec())!.replyToAddresses).toEqual(['swetha@gmail.com']);
    });
  });
});
