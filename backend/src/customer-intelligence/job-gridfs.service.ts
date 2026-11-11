import { Injectable } from '@nestjs/common';
import { GridFsService } from '../common/gridfs/gridfs.service';

const BUCKET = 'customer_job_references';

// JobBoard's "Reference" attachment (section 13, additive) — same
// thin-wrapper shape as crm/quote-gridfs.service.ts's identical field on
// Quote. Deliberately separate from the job's general Files/Proofs
// (customer-workspace.service.ts's FILES_BUCKET, kind: 'file'|'proof') —
// Reference is one quick pointer a user sets, not a managed multi-file
// list with its own uploader/approval metadata.
@Injectable()
export class JobGridFsService {
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
