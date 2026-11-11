import { Injectable } from '@nestjs/common';
import { GridFsService } from '../common/gridfs/gridfs.service';

const BUCKET = 'catalog_product_images';

// Same thin-wrapper shape as business-knowledge-gridfs.service.ts — one
// bucket per feature, the owning Product document stores only the returned
// fileId (see product.schema.ts's imageFileId).
@Injectable()
export class CatalogGridFsService {
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
