import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { Connection } from 'mongoose';
import { Readable } from 'stream';

// Extracted from finance-gridfs.service.ts (this codebase's first-ever
// GridFS use) once Business Knowledge became a second real consumer — same
// promotion trigger as MultiSelectDropdown/DateRangeControl's move to
// components/ui/ in Phase 10a. Parameterized by bucket name so each feature
// keeps its own GridFS bucket (finance_documents, business_knowledge_documents,
// ...) while sharing one implementation, mirroring how RedisCacheService is
// instantiated directly in every consuming module's own providers array (no
// CommonModule wrapper exists or is needed in this codebase).
//
// Uses mongoose's own re-exported `mongo` driver classes (mongoose.mongo.*)
// rather than importing the standalone `mongodb` package directly — mongoose
// bundles its own copy of the mongodb driver, and TypeScript treats that as
// a structurally different type from a separately-installed top-level
// `mongodb` package, even at the same version (Connection.db wouldn't be
// assignable to a directly-imported GridFSBucket's constructor param).
// Going through mongoose.mongo guarantees the exact same type identity.
@Injectable()
export class GridFsService {
  private buckets = new Map<string, mongoose.mongo.GridFSBucket>();

  constructor(@InjectConnection() private connection: Connection) {}

  // Lazy per-bucket getter, not built in onModuleInit — sidesteps any
  // startup-ordering risk between Mongoose's connection and this service's
  // construction.
  private getBucket(bucketName: string): mongoose.mongo.GridFSBucket {
    if (!this.buckets.has(bucketName)) {
      this.buckets.set(bucketName, new mongoose.mongo.GridFSBucket(this.connection.db!, { bucketName }));
    }
    return this.buckets.get(bucketName)!;
  }

  async upload(bucketName: string, filename: string, buffer: Buffer, metadata: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = this.getBucket(bucketName).openUploadStream(filename, { metadata });
      Readable.from(buffer)
        .pipe(stream)
        .on('error', reject)
        .on('finish', () => resolve(stream.id.toString()));
    });
  }

  // Explicit NodeJS.ReadableStream return type — GridFSBucket's own
  // openDownloadStream return type lives in mongoose's nested mongodb
  // module and can't be named portably across a composite-project
  // declaration boundary (surfaces as TS2742 in any file that re-exports
  // this method's inferred return type without annotating it, which is
  // exactly what the two per-feature wrapper services below do).
  openDownloadStream(bucketName: string, fileId: string): NodeJS.ReadableStream {
    return this.getBucket(bucketName).openDownloadStream(new mongoose.mongo.ObjectId(fileId));
  }

  /** A whole stored file, read back into memory. Rejects when the file is gone. */
  async download(bucketName: string, fileId: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.openDownloadStream(bucketName, fileId)) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  async delete(bucketName: string, fileId: string): Promise<void> {
    await this.getBucket(bucketName).delete(new mongoose.mongo.ObjectId(fileId));
  }
}
