import { randomUUID } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import FormData from 'form-data';
import { firstValueFrom } from 'rxjs';
import { ReservationService } from '../billing/reservation.service';
import { BusinessKnowledgeDocument, BusinessKnowledgeDocumentDocument } from './schemas/business-knowledge-document.schema';
import { BusinessKnowledgeGridFsService } from './business-knowledge-gridfs.service';
import { BusinessKnowledgeDocumentListQueryDto } from './dto/business-knowledge-document-list-query.dto';
import { UpdateBusinessKnowledgeDocumentDto } from './dto/update-business-knowledge-document.dto';
import { buildBusinessKnowledgeDocumentMatchStage } from './business-knowledge-filter.util';

const FILE_FORMAT_BY_EXT: Record<string, BusinessKnowledgeDocument['fileFormat']> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  xls: 'xls',
  csv: 'csv',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  html: 'html',
  htm: 'html',
  txt: 'txt',
  md: 'md',
};

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Mirrors finance-documents.service.ts's upload/extract/retry/CRUD shape
// exactly (see Phase 14a plan notes) — GridFS first (file never lost even if
// extraction fails), then a Mongo doc, then a synchronous extraction call.
// Deliberate deviation from Finance's own precedent: remove() here also
// purges the document's Qdrant points via python-agent's discard-source
// endpoint — Finance's remove() was found during design to never do this,
// a latent gap this module doesn't inherit.
@Injectable()
export class BusinessKnowledgeDocumentsService {
  private readonly logger = new Logger(BusinessKnowledgeDocumentsService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(BusinessKnowledgeDocument.name) private documentModel: Model<BusinessKnowledgeDocumentDocument>,
    private gridFs: BusinessKnowledgeGridFsService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
    private reservations: ReservationService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async upload(organizationId: string, userId: string, file: Express.Multer.File): Promise<BusinessKnowledgeDocumentDocument> {
    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
    const fileFormat = FILE_FORMAT_BY_EXT[ext];
    if (!fileFormat) {
      throw new BadRequestException(`Unsupported file type '.${ext}'`);
    }

    const gridFsFileId = await this.gridFs.upload(file.originalname, file.buffer, { organizationId, uploadedBy: userId });

    const created = await this.documentModel.create({
      organizationId,
      uploadedBy: userId,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      fileSizeBytes: file.size,
      gridFsFileId,
      fileFormat,
      assetType: 'other',
      extractionStatus: 'processing',
    });

    return this.runExtraction(created, organizationId, userId, file);
  }

  async retryExtraction(id: string, organizationId: string, userId: string): Promise<BusinessKnowledgeDocumentDocument> {
    const doc = await this.findOne(id, organizationId);
    const buffer = await streamToBuffer(this.gridFs.openDownloadStream(doc.gridFsFileId));
    const file = { buffer, originalname: doc.originalFilename, mimetype: doc.mimeType, size: doc.fileSizeBytes } as Express.Multer.File;
    return this.runExtraction(doc, organizationId, userId, file);
  }

  // Billed like business-knowledge-chat.service.ts's ask() — reserve()
  // called as a hard stop BEFORE any LLM call, outside the try/catch below,
  // so an insufficient-balance 402 propagates straight to the controller
  // (and the frontend's existing chat-error handling) instead of being
  // silently recorded as a generic "failed" document, which would hide the
  // real reason. Genuine extraction failures (bad file, python-agent error)
  // still land in the existing extractionStatus:'failed' path unchanged.
  private async runExtraction(
    doc: BusinessKnowledgeDocumentDocument,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<BusinessKnowledgeDocumentDocument> {
    const requestId = randomUUID();
    await this.reservations.reserve(organizationId, userId, requestId, `business-knowledge-doc:${doc._id.toString()}`);

    try {
      const extracted = await this.callExtraction(organizationId, userId, file, requestId);
      await this.reservations.settle(requestId);
      const updated = await this.documentModel
        .findByIdAndUpdate(doc._id, { $set: { ...extracted, extractionStatus: 'completed' }, $unset: { extractionError: '' } }, { new: true })
        .exec();
      return updated!;
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`Business knowledge document extraction failed for ${doc._id}: ${(err as Error).message}`);
      const updated = await this.documentModel
        .findByIdAndUpdate(doc._id, { extractionStatus: 'failed', extractionError: (err as Error).message }, { new: true })
        .exec();
      return updated!;
    }
  }

  private async callExtraction(organizationId: string, userId: string, file: Express.Multer.File, requestId: string) {
    const token = this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '5m' });
    const form = new FormData();
    form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
    form.append('request_id', requestId);

    const { data } = await firstValueFrom(
      this.http.post(`${this.pythonAgentUrl}/business-knowledge/documents/extract`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }),
    );
    return data as Record<string, unknown>;
  }

  async listFiltered(organizationId: string, query: BusinessKnowledgeDocumentListQueryDto) {
    const match = buildBusinessKnowledgeDocumentMatchStage(organizationId, query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const sortBy = query.sortBy ?? 'createdAt';
    const sortDir = query.sortDir === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
      this.documentModel
        .find(match)
        .sort({ [sortBy]: sortDir })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.documentModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize };
  }

  async findOne(id: string, organizationId: string): Promise<BusinessKnowledgeDocumentDocument> {
    const doc = await this.documentModel.findOne({ _id: id, organizationId }).exec();
    if (!doc) throw new NotFoundException('Business knowledge document not found');
    return doc;
  }

  async update(id: string, organizationId: string, userId: string, dto: UpdateBusinessKnowledgeDocumentDto) {
    const updated = await this.documentModel
      .findOneAndUpdate(
        { _id: id, organizationId },
        { $set: { ...dto, reviewStatus: 'reviewed', reviewedBy: userId, reviewedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Business knowledge document not found');
    return updated;
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const doc = await this.findOne(id, organizationId);
    await this.gridFs.delete(doc.gridFsFileId).catch((err: Error) => this.logger.error(`GridFS delete failed: ${err.message}`));
    if (doc.vectorDocumentId) {
      await firstValueFrom(
        this.http.post(`${this.pythonAgentUrl}/business-knowledge/documents/discard-source`, { documentId: doc.vectorDocumentId }, {
          headers: { Authorization: `Bearer ${this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '5m' })}` },
        }),
      ).catch((err: Error) => this.logger.error(`Qdrant discard-source failed: ${err.message}`));
    }
    await this.documentModel.deleteOne({ _id: id, organizationId }).exec();
  }

  async getFileStream(id: string, organizationId: string): Promise<{ stream: NodeJS.ReadableStream; doc: BusinessKnowledgeDocumentDocument }> {
    const doc = await this.findOne(id, organizationId);
    return { stream: this.gridFs.openDownloadStream(doc.gridFsFileId), doc };
  }
}
