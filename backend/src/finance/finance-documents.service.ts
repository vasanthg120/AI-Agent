import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import FormData from 'form-data';
import { firstValueFrom } from 'rxjs';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { QuotesService } from '../crm/quotes.service';
import { QuoteDocument } from '../crm/schemas/quote.schema';
import { FinanceDocument, FinanceDocumentDocument } from './schemas/finance-document.schema';
import { FinanceGridFsService } from './finance-gridfs.service';
import { FinanceFilterQueryDto } from './dto/finance-filter-query.dto';
import { FinanceListQueryDto } from './dto/finance-list-query.dto';
import { UpdateFinanceDocumentDto } from './dto/update-finance-document.dto';
import { buildFinanceMatchStage } from './finance-filter.util';

// Preview shape shown before/after linking — the same fields whether the
// caller is browsing search results or just confirmed a link, so the
// frontend can render both states with one component.
export interface CustomerQuoteMatch {
  quoteId: string;
  quoteNumber?: string;
  dealId?: string;
  customerName?: string;
  quoteAmount: number;
  currency: string;
  clientApprovalStatus: string;
}

const DOCUMENT_FORMAT_BY_EXT: Record<string, FinanceDocument['documentFormat']> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  xlsx: 'xlsx',
  xls: 'xls',
  csv: 'csv',
  docx: 'docx',
};

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Upload orchestration mirrors documents.service.ts's file-forward pattern
// (FormData + bridge JWT, same maxContentLength/maxBodyLength: Infinity),
// extended with GridFS storage + the extracted-fields persistence documents
// module never needed.
@Injectable()
export class FinanceDocumentsService {
  private readonly logger = new Logger(FinanceDocumentsService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(FinanceDocument.name) private documentModel: Model<FinanceDocumentDocument>,
    private gridFs: FinanceGridFsService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
    private usersService: UsersService,
    private notificationsService: NotificationsService,
    private quotesService: QuotesService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async upload(organizationId: string, userId: string, file: Express.Multer.File): Promise<FinanceDocumentDocument> {
    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
    const documentFormat = DOCUMENT_FORMAT_BY_EXT[ext];
    if (!documentFormat) {
      throw new BadRequestException(`Unsupported file type '.${ext}'`);
    }

    // File stored first, durably — never lost even if extraction below fails.
    const gridFsFileId = await this.gridFs.upload(file.originalname, file.buffer, { organizationId, uploadedBy: userId });

    const created = await this.documentModel.create({
      organizationId,
      uploadedBy: userId,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      fileSizeBytes: file.size,
      gridFsFileId,
      documentFormat,
      extractionStatus: 'processing',
    });

    return this.runExtraction(created, organizationId, userId, file);
  }

  async retryExtraction(id: string, organizationId: string, userId: string): Promise<FinanceDocumentDocument> {
    const doc = await this.findOne(id, organizationId);
    const buffer = await streamToBuffer(this.gridFs.openDownloadStream(doc.gridFsFileId));
    const file = { buffer, originalname: doc.originalFilename, mimetype: doc.mimeType, size: doc.fileSizeBytes } as Express.Multer.File;
    return this.runExtraction(doc, organizationId, userId, file);
  }

  private async runExtraction(
    doc: FinanceDocumentDocument,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<FinanceDocumentDocument> {
    try {
      const extracted = await this.callExtraction(organizationId, userId, file);
      const updated = await this.documentModel
        .findByIdAndUpdate(doc._id, { $set: { ...extracted, extractionStatus: 'completed' }, $unset: { extractionError: '' } }, { new: true })
        .exec();
      this.notifyOwners(organizationId, updated!).catch((err: Error) =>
        this.logger.error(`Failed to notify owners after finance upload: ${err.message}`),
      );
      return updated!;
    } catch (err) {
      this.logger.error(`Finance extraction failed for ${doc._id}: ${(err as Error).message}`);
      const updated = await this.documentModel
        .findByIdAndUpdate(doc._id, { extractionStatus: 'failed', extractionError: (err as Error).message }, { new: true })
        .exec();
      return updated!;
    }
  }

  private async callExtraction(organizationId: string, userId: string, file: Express.Multer.File) {
    const token = this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '5m' });
    const form = new FormData();
    form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });

    const { data } = await firstValueFrom(
      this.http.post(`${this.pythonAgentUrl}/finance/extract`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }),
    );
    return data as Record<string, unknown>;
  }

  // Fire-and-forget — a missed notification must never fail the upload
  // response.
  private async notifyOwners(organizationId: string, doc: FinanceDocumentDocument) {
    const users = await this.usersService.findAll(organizationId);
    const targets = users.filter((u) => u.roles.includes('owner') || u.roles.includes('admin'));
    await Promise.allSettled(
      targets.map((u) =>
        this.notificationsService.create(
          u._id.toString(),
          {
            kind: 'system',
            title: 'New finance document processed',
            description: `${doc.vendorName ?? 'Unknown vendor'} — ${doc.paymentAmount} ${doc.currency} (${doc.originalFilename})`,
            source: 'finance-document-processed',
            entityType: 'financeDocument',
            entityId: doc._id.toString(),
          },
          organizationId,
        ),
      ),
    );
  }

  async listFiltered(organizationId: string, query: FinanceListQueryDto) {
    const match = buildFinanceMatchStage(organizationId, query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const sortBy = query.sortBy ?? 'invoiceDate';
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

  async listForExport(organizationId: string, filters: FinanceFilterQueryDto, cap: number) {
    const match = buildFinanceMatchStage(organizationId, filters);
    const items = await this.documentModel.find(match).sort({ invoiceDate: -1 }).limit(cap + 1).exec();
    const truncated = items.length > cap;
    return { items: truncated ? items.slice(0, cap) : items, truncated };
  }

  async findOne(id: string, organizationId: string): Promise<FinanceDocumentDocument> {
    const doc = await this.documentModel.findOne({ _id: id, organizationId }).exec();
    if (!doc) throw new NotFoundException('Finance document not found');
    return doc;
  }

  async update(id: string, organizationId: string, userId: string, dto: UpdateFinanceDocumentDto) {
    const updated = await this.documentModel
      .findOneAndUpdate(
        { _id: id, organizationId },
        { $set: { ...dto, reviewStatus: 'reviewed', reviewedBy: userId, reviewedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Finance document not found');
    return updated;
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const doc = await this.findOne(id, organizationId);
    await this.gridFs.delete(doc.gridFsFileId).catch((err: Error) => this.logger.error(`GridFS delete failed: ${err.message}`));
    await this.documentModel.deleteOne({ _id: id, organizationId }).exec();
  }

  async getFileStream(id: string, organizationId: string): Promise<{ stream: NodeJS.ReadableStream; doc: FinanceDocumentDocument }> {
    const doc = await this.findOne(id, organizationId);
    return { stream: this.gridFs.openDownloadStream(doc.gridFsFileId), doc };
  }

  private toQuoteMatch(quote: QuoteDocument): CustomerQuoteMatch {
    return {
      quoteId: quote._id.toString(),
      quoteNumber: quote.quoteNumber,
      dealId: quote.dealId,
      customerName: quote.clientDetails?.companyName ?? quote.quoteName,
      quoteAmount: quote.quoteAmount,
      currency: quote.currency,
      clientApprovalStatus: quote.clientApprovalStatus,
    };
  }

  // Step 1 of the Vendor Quote <-> Customer Quote linking flow — searches
  // the org's own CRM quotes (QuotesService.findByQuoteNumber, org-scoped)
  // for a human to confirm before anything is saved. Zero matches is a
  // normal, valid result (not an error) — the caller shows "not found";
  // more than one match means the caller must show a picker, never
  // auto-select.
  async searchCustomerQuotes(organizationId: string, quoteNumber: string): Promise<CustomerQuoteMatch[]> {
    const quotes = await this.quotesService.findByQuoteNumber(organizationId, quoteNumber);
    return quotes.map((q) => this.toQuoteMatch(q));
  }

  // Step 2 — persists the link the user confirmed. quoteId is re-resolved
  // through QuotesService.getOne, which matches { _id, organizationId } —
  // the real organization-isolation guarantee: even a tampered/wrong-org
  // quoteId can never be linked, regardless of what the client sends.
  // Re-linking (a different quoteId than what's already stored) is allowed
  // — the frontend is responsible for warning the user first when a document
  // is already linked (see FinanceDocument.quoteId/customerQuoteNo on the
  // existing document it already has in hand) — this method itself has no
  // documented business reason to refuse a correction.
  //
  // dealId is populated from the quote's own dealId when it has one — this
  // is the one field vendor-profitability.service.ts's getOverview() actually
  // groups by, so a customer quote with no linked deal will link
  // successfully (quoteId/customerQuoteNo are still saved) but won't feed
  // Vendor Profitability, which is an existing, pre-dating limitation of
  // that dealId-keyed join, not something this method introduces.
  async linkCustomerQuote(id: string, organizationId: string, quoteId: string): Promise<{ document: FinanceDocumentDocument; linkedQuote: CustomerQuoteMatch }> {
    await this.findOne(id, organizationId);
    const quote = await this.quotesService.getOne(organizationId, quoteId);

    const setFields: Record<string, unknown> = { quoteId: quote._id.toString(), customerQuoteNo: quote.quoteNumber };
    if (quote.dealId) setFields.dealId = quote.dealId;

    const updated = await this.documentModel.findByIdAndUpdate(id, { $set: setFields }, { new: true }).exec();
    return { document: updated!, linkedQuote: this.toQuoteMatch(quote) };
  }
}
