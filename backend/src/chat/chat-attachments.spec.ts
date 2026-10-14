import { BadRequestException, ForbiddenException, PayloadTooLargeException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';
import { ChatAttachmentsController } from './chat-attachments.controller';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ChatAttachment, ChatAttachmentDocument, ChatAttachmentSchema } from './schemas/chat-attachment.schema';

const PREFIX = `jest-att-${Date.now()}`;
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)]);

function file(name: string, buffer: Buffer): Express.Multer.File {
  return { originalname: name, buffer, size: buffer.length, mimetype: 'application/octet-stream' } as Express.Multer.File;
}

// Against a real Mongo: what may be attached, who can use an attachment, and
// that its text is never stored or returned in the clear.
describe('Chat attachments (real Mongo)', () => {
  let connection: Connection;
  let model: Model<ChatAttachmentDocument>;
  let service: ChatAttachmentsService;
  const http = { post: jest.fn() };
  const encryption = { encrypt: (text: string) => `enc(${Buffer.from(text).toString('base64')})` };
  let seq = 0;
  let org: string;
  let user: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: ChatAttachment.name, schema: ChatAttachmentSchema }])],
    }).compile();
    model = moduleRef.get(getModelToken(ChatAttachment.name));
    connection = moduleRef.get(getConnectionToken());
    await model.init();
    service = new ChatAttachmentsService(model, http as never, encryption as never, { get: () => undefined } as never);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    user = `${PREFIX}-user-${seq}`;
    http.post.mockReset();
    http.post.mockReturnValue(of({ data: { text: 'Termination requires ninety days notice.', truncated: false } }));
  });

  afterAll(async () => {
    await model.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  it('stores a valid document as encrypted text and returns only its description', async () => {
    const view = await service.upload(user, org, 'jwt', file('C:\\fake\\Contract <final>.PDF', PDF));
    expect(view).toMatchObject({ name: 'Contract final.PDF', mimeType: 'application/pdf', sizeBytes: PDF.length, truncated: false });
    expect(JSON.stringify(view)).not.toContain('ninety days');

    const stored = await model.findById(view.id).select('+textEncrypted').lean();
    expect(stored?.textEncrypted).toMatch(/^enc\(/);
    expect(stored?.textEncrypted).not.toContain('ninety days');
    expect(stored?.conversationId).toBeUndefined();
    // A pending upload expires within a day.
    expect(stored!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    // The default projection never includes the text.
    expect((await model.findById(view.id).lean())?.textEncrypted).toBeUndefined();
  });

  it('refuses unsupported types, disguised content, empty and oversized files — before any extraction', async () => {
    await expect(service.upload(user, org, 'jwt', file('run.exe', Buffer.from('MZ\u0090')))).rejects.toThrow(BadRequestException);
    await expect(service.upload(user, org, 'jwt', file('macro.docm', DOCX))).rejects.toThrow(/can’t be attached/);
    // An executable renamed to .pdf / .txt, and a zip renamed to .csv.
    await expect(service.upload(user, org, 'jwt', file('invoice.pdf', Buffer.from('MZ\u0090\u0000binary')))).rejects.toThrow(/isn’t a valid .pdf/);
    await expect(service.upload(user, org, 'jwt', file('notes.txt', Buffer.from('MZ\u0090\u0000\u0003')))).rejects.toThrow(/isn’t a valid .txt/);
    await expect(service.upload(user, org, 'jwt', file('data.csv', DOCX))).rejects.toThrow(/isn’t a valid .csv/);
    await expect(service.upload(user, org, 'jwt', file('empty.pdf', Buffer.alloc(0)))).rejects.toThrow('The file is empty.');
    const big = file('big.pdf', PDF);
    big.size = 26 * 1024 * 1024;
    await expect(service.upload(user, org, 'jwt', big)).rejects.toThrow(PayloadTooLargeException);
    expect(http.post).not.toHaveBeenCalled();
    expect(await model.countDocuments({ organizationId: org })).toBe(0);
  });

  it('passes on why a document could not be read, and stores nothing', async () => {
    http.post.mockReturnValue(throwError(() => ({ response: { status: 422, data: { detail: 'No readable text was found in this file.' } } })));
    await expect(service.upload(user, org, 'jwt', file('scan.pdf', PDF))).rejects.toThrow('No readable text was found in this file.');
    expect(await model.countDocuments({ organizationId: org })).toBe(0);
  });

  it('reuses the same document picked twice before sending', async () => {
    const first = await service.upload(user, org, 'jwt', file('a.docx', DOCX));
    const again = await service.upload(user, org, 'jwt', file('copy of a.docx', DOCX));
    expect(again.id).toBe(first.id);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('links attachments to a conversation only for their owner, and only once', async () => {
    const mine = await service.upload(user, org, 'jwt', file('mine.pdf', PDF));
    const theirs = await service.upload(`${user}-other`, org, 'jwt', file('theirs.docx', DOCX));

    // Someone else's id, or the same user in another organization: refused whole.
    await expect(service.attach(user, org, 'conv-1', [mine.id, theirs.id])).rejects.toThrow(/could not be found/);
    await expect(service.attach(user, `${org}-x`, 'conv-1', [mine.id])).rejects.toThrow(/could not be found/);
    await expect(service.attach(user, org, 'conv-1', ['not-an-id'])).rejects.toThrow(/could not be found/);
    expect((await model.findById(mine.id).lean())?.conversationId).toBeUndefined();

    const attached = await service.attach(user, org, 'conv-1', [mine.id]);
    expect(attached.map((a) => a.name)).toEqual(['mine.pdf']);
    const stored = await model.findById(mine.id).lean();
    expect(stored?.conversationId).toBe('conv-1');
    // Sent documents are kept for the retention period (30 days by default).
    expect(stored!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);

    // Not reusable in another conversation; re-sending in the same one is harmless.
    await expect(service.attach(user, org, 'conv-2', [mine.id])).rejects.toThrow(/could not be found/);
    await expect(service.attach(user, org, 'conv-1', [mine.id])).resolves.toHaveLength(1);
  });

  it('enforces the per-message limit and removes a conversation’s documents with it', async () => {
    await expect(service.attach(user, org, 'conv-1', ['1', '2', '3', '4', '5', '6'])).rejects.toThrow('Attach up to 5 documents per message.');

    const doc = await service.upload(user, org, 'jwt', file('keep.pdf', PDF));
    await service.attach(user, org, 'conv-9', [doc.id]);
    await service.removeForConversation(`${user}-other`, 'conv-9');
    expect(await model.countDocuments({ conversationId: 'conv-9' })).toBe(1);
    await service.removeForConversation(user, 'conv-9');
    expect(await model.countDocuments({ conversationId: 'conv-9' })).toBe(0);

    await expect(service.remove(user, org, doc.id)).rejects.toThrow('Attachment not found.');
  });
});

describe('ChatAttachmentsController', () => {
  it('refuses uploads from an account whose AI access is switched off', () => {
    const service = { upload: jest.fn() };
    const controller = new ChatAttachmentsController(service as never);
    const user = { sub: 'u', organizationId: 'o', email: 'e', roles: ['user'], aiAccessEnabled: false };
    expect(() => controller.upload(user as never, { headers: {} } as never, file('a.pdf', PDF))).toThrow(ForbiddenException);
    expect(service.upload).not.toHaveBeenCalled();
  });
});
