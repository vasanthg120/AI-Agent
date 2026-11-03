import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CloudAccessService } from '../cloud-files/cloud-access.service';
import { CloudConnectionsService } from '../cloud-files/cloud-connections.service';
import { CloudError } from '../cloud-files/cloud-http';
import { CloudItem } from '../cloud-files/cloud-files.types';
import { CloudConnectionDocument } from '../cloud-files/schemas/cloud-connection.schema';
import { CLOUD_FOLDERS_COLLECTION, CLOUD_INDEX_COLLECTION, CLOUD_LINKS_COLLECTION } from './customer-cloud.service';
// What one sync of one account may cost the provider at most: the rest waits for the next run.
const MAX_LINK_CHECKS = 300;
const MAX_FOLDER_LISTINGS = 150;
const MAX_INDEXED_PER_FOLDER = 1_000;
const MAX_DEPTH = 6;

type Doc = Record<string, any>;

export interface CloudSyncSummary {
  linksChecked: number;
  linksChanged: number;
  linksGone: number;
  foldersIndexed: number;
  filesIndexed: number;
  /** Something was left for the next run (the limits above were reached). */
  partial: boolean;
}

// Keeps what HaiVE knows of customers' cloud documents true to the cloud: an
// attached file renamed, moved, deleted or no longer shared is said so on the
// customer; and the files inside each customer folder are listed (names, types,
// dates — never their content) so the customer's documents can be searched all
// the way down. Runs every 15 minutes for every connected account that holds
// customer documents, and on demand ("Sync now").
//
// Neither Google nor Microsoft offers a change feed for one folder of a business
// drive (OneDrive for Business has delta only from the drive's root), so each
// attached file is checked by its stable id and each customer folder is walked,
// within the limits above.
@Injectable()
export class CustomerCloudSyncService implements OnModuleInit {
  private readonly logger = new Logger(CustomerCloudSyncService.name);
  private running = new Set<string>();

  constructor(
    @InjectConnection() private db: Connection,
    private connections: CloudConnectionsService,
    private access: CloudAccessService,
  ) {}

  async onModuleInit() {
    await this.db.collection(CLOUD_INDEX_COLLECTION).createIndex({ organizationId: 1, mappingId: 1 }).catch(() => undefined);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduled(): Promise<void> {
    const ids = new Set<string>([
      ...((await this.db.collection(CLOUD_FOLDERS_COLLECTION).distinct('connectionId')) as string[]),
      ...((await this.db.collection(CLOUD_LINKS_COLLECTION).distinct('connectionId')) as string[]),
    ]);
    for (const id of ids) {
      if (!Types.ObjectId.isValid(id)) continue;
      const connection = await this.db.collection('cloud_connections').findOne({ _id: new Types.ObjectId(id) }, { projection: { organizationId: 1, lastSyncAt: 1, status: 1 } });
      if (!connection || connection.status === 'needs_reauth') continue;
      // About every 15 minutes per account (the job looks every 5).
      if (connection.lastSyncAt && Date.now() - new Date(connection.lastSyncAt).getTime() < 14 * 60_000) continue;
      try {
        await this.syncConnection(await this.connections.find(String(connection.organizationId), id));
      } catch (err) {
        this.logger.warn(`Cloud sync of ${id} failed: ${(err as CloudError).detail ?? (err as Error).message}`);
      }
    }
  }

  /** "Sync now" for one account the person may open. */
  async syncNow(caller: JwtPayload, connectionId: string): Promise<CloudSyncSummary> {
    const scope = await this.access.open(caller, connectionId);
    return this.syncConnection(scope.connection);
  }

  async syncConnection(connection: CloudConnectionDocument): Promise<CloudSyncSummary> {
    const key = connection._id.toString();
    const summary: CloudSyncSummary = { linksChecked: 0, linksChanged: 0, linksGone: 0, foldersIndexed: 0, filesIndexed: 0, partial: false };
    if (this.running.has(key)) return { ...summary, partial: true };
    this.running.add(key);
    try {
      await this.checkLinks(connection, summary);
      await this.indexFolders(connection, summary);
      await this.connections.recordSync(connection, { ok: true });
      return summary;
    } catch (err) {
      const message = err instanceof CloudError ? err.message : 'The sync couldn’t be completed.';
      await this.connections.recordSync(connection, { ok: false, error: message });
      throw err;
    } finally {
      this.running.delete(key);
    }
  }

  /** Each attached file, by its id: still there? renamed? moved? */
  private async checkLinks(connection: CloudConnectionDocument, summary: CloudSyncSummary) {
    const provider = this.connections.provider(connection.provider);
    const links = await this.db
      .collection(CLOUD_LINKS_COLLECTION)
      .find({ organizationId: connection.organizationId, connectionId: connection._id.toString() })
      .sort({ lastCheckedAt: 1 })
      .limit(MAX_LINK_CHECKS + 1)
      .toArray();
    if (links.length > MAX_LINK_CHECKS) summary.partial = true;
    for (const link of links.slice(0, MAX_LINK_CHECKS)) {
      summary.linksChecked += 1;
      const set: Doc = { lastCheckedAt: new Date() };
      try {
        const item = await this.connections.withToken(connection, (token) => provider.get(token, String(link.fileId)));
        const moved = !!item.parentId && !!link.parentId && item.parentId !== link.parentId;
        Object.assign(set, {
          name: item.name,
          size: item.size,
          mimeType: item.mimeType,
          modifiedAt: item.modifiedAt ? new Date(item.modifiedAt) : link.modifiedAt,
          webUrl: item.webUrl ?? link.webUrl,
          status: moved || link.status === 'moved' ? 'moved' : 'available',
        });
        if (moved) {
          const above = await this.connections.withToken(connection, (token) => provider.ancestors(token, item.id));
          set.parentId = item.parentId;
          set.location = [...above].reverse().map((a) => a.name).join(' / ');
        }
        if (item.name !== link.name || moved || link.status !== set.status) summary.linksChanged += 1;
      } catch (err) {
        if (!(err instanceof CloudError) || !['not_found', 'permission'].includes(err.kind)) throw err;
        set.status = err.kind === 'not_found' ? 'deleted' : 'no_access';
        if (link.status !== set.status) summary.linksGone += 1;
      }
      await this.db.collection(CLOUD_LINKS_COLLECTION).updateOne({ _id: link._id }, { $set: set });
    }
  }

  /** What is inside each customer folder of this account (names and dates only), for searching it all the way down. */
  private async indexFolders(connection: CloudConnectionDocument, summary: CloudSyncSummary) {
    const provider = this.connections.provider(connection.provider);
    const folders = await this.db.collection(CLOUD_FOLDERS_COLLECTION).find({ organizationId: connection.organizationId, connectionId: connection._id.toString() }).toArray();
    let listings = 0;
    for (const folder of folders) {
      const found: (CloudItem & { path: string })[] = [];
      const queue: { id: string; path: string; depth: number }[] = [{ id: String(folder.folderId), path: '', depth: 0 }];
      let complete = true;
      try {
        while (queue.length > 0) {
          if (listings >= MAX_FOLDER_LISTINGS || found.length >= MAX_INDEXED_PER_FOLDER) {
            complete = false;
            break;
          }
          const next = queue.shift()!;
          let cursor: string | undefined;
          do {
            listings += 1;
            const page = await this.connections.withToken(connection, (token) => provider.list(token, next.id, { cursor }));
            for (const item of page.items) {
              found.push({ ...item, path: next.path });
              if (item.kind === 'folder' && next.depth + 1 < MAX_DEPTH) queue.push({ id: item.id, path: next.path ? `${next.path} / ${item.name}` : item.name, depth: next.depth + 1 });
            }
            cursor = page.cursor;
          } while (cursor && listings < MAX_FOLDER_LISTINGS);
        }
      } catch (err) {
        // The folder itself is gone or no longer shared: its index is dropped, the customer still shows the link.
        if (err instanceof CloudError && ['not_found', 'permission'].includes(err.kind)) {
          await this.db.collection(CLOUD_INDEX_COLLECTION).deleteMany({ organizationId: connection.organizationId, mappingId: folder._id.toString() });
          continue;
        }
        throw err;
      }
      if (!complete) summary.partial = true;
      const mappingId = folder._id.toString();
      const now = new Date();
      // Replaced as a whole only when the walk finished: a partial walk never makes files look deleted.
      if (complete) await this.db.collection(CLOUD_INDEX_COLLECTION).deleteMany({ organizationId: connection.organizationId, mappingId });
      if (found.length > 0)
        await this.db.collection(CLOUD_INDEX_COLLECTION).bulkWrite(
          found.map((item) => ({
            updateOne: {
              filter: { organizationId: connection.organizationId, mappingId, itemId: item.id },
              update: {
                $set: {
                  organizationId: connection.organizationId,
                  mappingId,
                  customerKeys: folder.customerKeys,
                  provider: connection.provider,
                  itemId: item.id,
                  name: item.name,
                  nameLower: item.name.toLowerCase(),
                  kind: item.kind,
                  mimeType: item.mimeType,
                  size: item.size,
                  modifiedAt: item.modifiedAt ? new Date(item.modifiedAt) : undefined,
                  webUrl: item.webUrl,
                  parentId: item.parentId,
                  path: item.path,
                  indexedAt: now,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      await this.db.collection(CLOUD_FOLDERS_COLLECTION).updateOne({ _id: folder._id }, { $set: { indexedAt: now, indexedCount: found.length, indexComplete: complete } });
      summary.foldersIndexed += 1;
      summary.filesIndexed += found.length;
    }
  }
}
