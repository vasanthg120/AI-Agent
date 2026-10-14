import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { createHash } from 'crypto';
import FormData from 'form-data';
import { Model, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { EncryptionService } from '../common/encryption/encryption.service';
import { ChatAttachment, ChatAttachmentDocument } from './schemas/chat-attachment.schema';

export interface ChatAttachmentView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  extractedChars: number;
  // Only the first part of a very long document was kept.
  truncated: boolean;
}

export interface ChatAttachmentLimits {
  extensions: string[];
  maxFileBytes: number;
  maxPerMessage: number;
  maxPerConversation: number;
  retentionDays: number;
}

type Kind = 'pdf' | 'zip' | 'ole' | 'png' | 'jpeg' | 'webp' | 'text';

// What can be attached, the content each extension must really have, and the
// MIME type recorded for it (never the browser's own claim).
const TYPES: Record<string, { kind: Kind; mimeType: string }> = {
  '.pdf': { kind: 'pdf', mimeType: 'application/pdf' },
  '.docx': { kind: 'zip', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xlsx': { kind: 'zip', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.pptx': { kind: 'zip', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.xls': { kind: 'ole', mimeType: 'application/vnd.ms-excel' },
  // Images (and scanned PDFs) are read by the vision model at upload.
  '.png': { kind: 'png', mimeType: 'image/png' },
  '.jpg': { kind: 'jpeg', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'jpeg', mimeType: 'image/jpeg' },
  '.webp': { kind: 'webp', mimeType: 'image/webp' },
  '.csv': { kind: 'text', mimeType: 'text/csv' },
  '.txt': { kind: 'text', mimeType: 'text/plain' },
  '.md': { kind: 'text', mimeType: 'text/markdown' },
  '.html': { kind: 'text', mimeType: 'text/html' },
  '.htm': { kind: 'text', mimeType: 'text/html' },
};

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_USER = 20;

/** Whether the bytes are what the extension says: a renamed executable or
 * archive must not get through on its file name alone. */
function contentMatches(kind: Kind, buffer: Buffer): boolean {
  const head = buffer.subarray(0, 1024);
  if (kind === 'pdf') return head.includes(Buffer.from('%PDF-'));
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  if (kind === 'zip') return startsWith(0x50, 0x4b, 0x03, 0x04);
  if (kind === 'ole') return startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  if (kind === 'png') return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (kind === 'jpeg') return startsWith(0xff, 0xd8, 0xff);
  if (kind === 'webp') return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  // Text: no NUL bytes in the first 8KB (every binary format has them), and
  // not a PDF/zip/Windows executable saved under a text extension.
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return false;
  const start = sample.subarray(0, 5).toString('latin1');
  return !start.startsWith('%PDF') && !start.startsWith('PK\u0003\u0004') && !start.startsWith('MZ');
}

function cleanFilename(original: string): string {
  // Browsers send latin1-decoded bytes for non-ASCII names; recover UTF-8 when that's what it was.
  let name = original;
  try {
    const recovered = Buffer.from(original, 'latin1').toString('utf8');
    if (!recovered.includes('�')) name = recovered;
  } catch {
    // keep the original
  }
  name = (name.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .trim();
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    name = dot > 0 ? `${name.slice(0, 150 - (name.length - dot))}${name.slice(dot)}` : name.slice(0, 150);
  }
  return name || 'document';
}

// Documents attached in the AI chat. Each upload is validated (type, real
// content, size), has its text extracted by python-agent, and is stored as
// encrypted text owned by one user in one organization — the original file is
// not kept. Sending a message links its attachments to that conversation,
// after which python-agent includes them as context on every turn of it.
@Injectable()
export class ChatAttachmentsService {
  private readonly logger = new Logger(ChatAttachmentsService.name);
  private readonly agentUrl: string;
  readonly limits: ChatAttachmentLimits;

  constructor(
    @InjectModel(ChatAttachment.name) private attachmentModel: Model<ChatAttachmentDocument>,
    private http: HttpService,
    private encryption: EncryptionService,
    config: ConfigService,
  ) {
    this.agentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
    this.limits = {
      extensions: Object.keys(TYPES),
      maxFileBytes: config.get<number>('chat.attachments.maxFileBytes') ?? 25 * 1024 * 1024,
      maxPerMessage: config.get<number>('chat.attachments.maxPerMessage') ?? 5,
      maxPerConversation: config.get<number>('chat.attachments.maxPerConversation') ?? 10,
      retentionDays: config.get<number>('chat.attachments.retentionDays') ?? 30,
    };
  }

  private toView(doc: ChatAttachmentDocument): ChatAttachmentView {
    return {
      id: doc._id.toString(),
      name: doc.filename,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      extractedChars: doc.extractedChars,
      truncated: doc.truncated,
    };
  }

  private async extractText(userJwt: string, filename: string, mimeType: string, buffer: Buffer): Promise<{ text: string; truncated: boolean }> {
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimeType });
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ text: string; truncated: boolean }>(`${this.agentUrl}/chat/attachments/extract`, form, {
          headers: { ...form.getHeaders(), Authorization: `Bearer ${userJwt}` },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          // An image or scanned PDF is read by the vision model, which can take a while.
          timeout: 240_000,
        }),
      );
      return data;
    } catch (err) {
      const response = (err as AxiosError<{ detail?: unknown }>).response;
      if (response?.status === 422 && typeof response.data?.detail === 'string') throw new BadRequestException(response.data.detail);
      this.logger.error(`Text extraction failed for a chat attachment: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The document couldn’t be processed right now. Please try again in a minute.');
    }
  }

  /** Validates and stores one uploaded document; returns what the chat shows for it. */
  async upload(userId: string, organizationId: string, userJwt: string, file: Express.Multer.File | undefined): Promise<ChatAttachmentView> {
    if (!file?.buffer?.length) throw new BadRequestException('The file is empty.');
    if (file.size > this.limits.maxFileBytes) {
      throw new PayloadTooLargeException(`Files can be up to ${Math.round(this.limits.maxFileBytes / (1024 * 1024))} MB.`);
    }
    const filename = cleanFilename(file.originalname ?? '');
    const dot = filename.lastIndexOf('.');
    const extension = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
    const type = TYPES[extension];
    if (extension === '.doc') {
      throw new BadRequestException('Old Word files (.doc) can’t be read. Open it in Word, save it as .docx (or PDF) and attach that.');
    }
    if (!type) {
      throw new BadRequestException(
        `${extension || 'This file type'} can’t be attached. Supported: PDF, Word (.docx), Excel (.xlsx, .xls), PowerPoint (.pptx), CSV, text, and images (PNG, JPG, WebP).`,
      );
    }
    if (!contentMatches(type.kind, file.buffer)) {
      throw new BadRequestException(`“${filename}” isn’t a valid ${extension} file. Check the file and try again.`);
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    // The same document picked again before sending: reuse it.
    const pending = await this.attachmentModel
      .find({ userId, organizationId, conversationId: { $exists: false } })
      .sort({ createdAt: -1 })
      .exec();
    const same = pending.find((p) => p.sha256 === sha256);
    if (same) return this.toView(same);
    if (pending.length >= MAX_PENDING_PER_USER) {
      throw new BadRequestException('You have too many unsent attachments. Send or remove some, then try again.');
    }

    const { text, truncated } = await this.extractText(userJwt, filename, type.mimeType, file.buffer);
    const doc = await this.attachmentModel.create({
      organizationId,
      userId,
      filename,
      extension,
      mimeType: type.mimeType,
      sizeBytes: file.size,
      sha256,
      status: 'ready',
      textEncrypted: this.encryption.encrypt(text),
      extractedChars: text.length,
      truncated: !!truncated,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    this.logger.log(`Chat attachment ${doc._id.toString()} stored (${extension}, ${file.size} bytes, ${text.length} chars) for org ${organizationId}`);
    return this.toView(doc);
  }

  /** Links pending attachments to the conversation a message is being sent
   * in. Every id must be the caller's own, in their organization, and not
   * already used in another conversation — anything else is refused whole. */
  async attach(userId: string, organizationId: string, conversationId: string, ids: string[] | undefined): Promise<ChatAttachmentView[]> {
    const unique = [...new Set(ids ?? [])];
    if (unique.length === 0) return [];
    if (unique.length > this.limits.maxPerMessage) {
      throw new BadRequestException(`Attach up to ${this.limits.maxPerMessage} documents per message.`);
    }
    if (!unique.every((id) => isValidObjectId(id))) throw new BadRequestException('An attachment could not be found. Upload it again.');
    const docs = await this.attachmentModel.find({ _id: { $in: unique }, userId, organizationId, status: 'ready' }).exec();
    if (docs.length !== unique.length || docs.some((d) => d.conversationId && d.conversationId !== conversationId)) {
      throw new BadRequestException('An attachment could not be found (it may have expired). Upload it again.');
    }
    const fresh = docs.filter((d) => !d.conversationId);
    const already = await this.attachmentModel.countDocuments({ conversationId, userId }).exec();
    if (already + fresh.length > this.limits.maxPerConversation) {
      throw new BadRequestException(
        `A conversation can hold up to ${this.limits.maxPerConversation} documents. Start a new conversation for more.`,
      );
    }
    await this.attachmentModel
      .updateMany(
        { _id: { $in: fresh.map((d) => d._id) } },
        { $set: { conversationId, expiresAt: new Date(Date.now() + this.limits.retentionDays * 24 * 60 * 60 * 1000) } },
      )
      .exec();
    // In the order they were attached.
    return unique.map((id) => this.toView(docs.find((d) => d._id.toString() === id)!));
  }

  /** Removes one of the caller's attachments (and so its text). */
  async remove(userId: string, organizationId: string, id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new NotFoundException('Attachment not found.');
    const result = await this.attachmentModel.deleteOne({ _id: id, userId, organizationId }).exec();
    if (result.deletedCount === 0) throw new NotFoundException('Attachment not found.');
  }

  /** A deleted conversation takes its documents with it. */
  async removeForConversation(userId: string, conversationId: string): Promise<void> {
    await this.attachmentModel.deleteMany({ conversationId, userId }).exec();
  }
}
