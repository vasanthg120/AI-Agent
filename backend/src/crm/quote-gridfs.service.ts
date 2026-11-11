import { Injectable } from '@nestjs/common';
import { GridFsService } from '../common/gridfs/gridfs.service';

const BUCKET = 'crm_quote_references';

// SalesBoard's "Reference" attachment (Phase 4, additive) — same
// thin-wrapper shape as catalog-gridfs.service.ts, one bucket for this one
// feature; the owning Quote document stores only the returned fileId (see
// quote.schema.ts's referenceFileId).
@Injectable()
export class QuoteGridFsService {
  constructor(private gridFs: GridFsService) {}

  upload(filename: string, buffer: Buffer, metadata: Record<string, unknown>): Promise<string> {
    return this.gridFs.upload(BUCKET, filename, buffer, metadata);
  }

  openDownloadStream(fileId: string): NodeJS.ReadableStream {
    return this.gridFs.openDownloadStream(BUCKET, fileId);
  }

  delete(fileId: string): Promise<void> {
    return this.gridFs.delete(BUCKET, fileId);
  }
}
