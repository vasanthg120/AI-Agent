import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { promises as fs } from 'fs';
import { Connection, Types } from 'mongoose';
import { Readable } from 'stream';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CloudAccessService, CloudScope } from '../cloud-files/cloud-access.service';
import { CloudConnectionsService } from '../cloud-files/cloud-connections.service';
import { CloudError } from '../cloud-files/cloud-http';
import { CLOUD_PROVIDER_LABEL, CloudFileType, CloudItem, CloudProviderId, CloudSort, fileTypeOf, inlineType, ListResult } from '../cloud-files/cloud-files.types';
import { CloudConnectionDocument } from '../cloud-files/schemas/cloud-connection.schema';
import { assertAcceptableFile, cleanFileName } from '../common/file-names';
import { UPLOAD_FILE_SIZE_LIMIT_BYTES } from '../common/upload-limits';
import { CustomerDirectoryService, FILES_BUCKET } from './customer-directory.service';
import { CustomerFile, CustomerWorkspaceService } from './customer-workspace.service';

export const CLOUD_FOLDERS_COLLECTION = 'customer_cloud_folders';
export const CLOUD_LINKS_COLLECTION = 'customer_cloud_links';
/** What the sync found inside customer folders — names and dates, never content (customer-cloud-sync.service.ts). */
export const CLOUD_INDEX_COLLECTION = 'customer_cloud_index';
const MAX_LINKS_PER_CUSTOMER = 200;
const MAX_ATTACH_AT_ONCE = 20;

export const DOCUMENT_CATEGORIES = ['quotation', 'invoice', 'contract', 'purchase_order', 'order', 'email_attachment', 'other'] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** What "Create a customer folder" makes inside it, when asked to. */
export const CUSTOMER_SUBFOLDERS = [
  { key: 'quotations', label: 'Quotations' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'orders', label: 'Orders' },
  { key: 'general', label: 'General Documents' },
] as const;

type Doc = Record<string, any>;
const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');

/** Whether the person asking can open a stored folder or file, without asking the provider first. */
export type CloudReach = 'open' | 'own_account' | 'reconnect' | 'disconnected';

export interface CustomerCloudFolder {
  id: string;
  provider: CloudProviderId;
  ownership: 'personal' | 'company';
  folderId: string;
  name: string;
  webUrl?: string;
  /** Whose account it is in ("Priya's Google Drive"), when it is someone's own. */
  ownerName?: string;
  accountEmail?: string;
  subfolders: { key: string; label: string; folderId: string }[];
  linkedBy: string;
  at: Date;
  reach: CloudReach;
  canUnlink: boolean;
  /** When the last sync listed what is inside it (for searching it all the way down), and how much it found. */
  indexedAt?: Date;
  indexedCount?: number;
}

export interface CustomerCloudLink {
  id: string;
  provider: CloudProviderId;
  ownership: 'personal' | 'company';
  fileId: string;
  name: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: Date;
  webUrl?: string;
  /** Where it was in the provider when attached (or last synced). */
  location?: string;
  category: DocumentCategory;
  linkedTo?: { kind: 'quotation'; id: string; label: string };
  attachedBy: string;
  at: Date;
  /** available · moved (still there, elsewhere) · deleted · no_access (the account can't open it any more). */
  status: 'available' | 'moved' | 'deleted' | 'no_access';
  ownerName?: string;
  reach: CloudReach;
  canRemove: boolean;
}

/** One of HaiVE's own customer files, as the Files page lists them across customers. */
export interface HaiveCustomerFile {
  id: string;
  customerId: string;
  customerName: string;
  name: string;
  size: number;
  type: string;
  uploadedBy: string;
  at: Date;
  /** Copied in from Google Drive / OneDrive, when it was. */
  copiedFrom?: CloudProviderId;
}

interface StoredRef {
  connectionId: string;
  provider: CloudProviderId;
  ownership: 'personal' | 'company';
  connectionUserId: string;
}

// A customer's documents in Google Drive / OneDrive: folders linked to the
// customer (or made for them, on request) and single cloud files attached to
// them. Stored against the customer's identity keys — their email addresses and
// phone numbers — exactly like comments, tasks and HaiVE's own files, never by a
// business name, so two customers with similar names never share documents.
//
// Opening one:
//  - in the company account: anyone who may open the customer may open it, but
//    only inside that customer's folder (or that one attached file);
//  - in someone's own account: with the viewer's own account of the same
//    provider, so Google/Microsoft sharing decides. Nobody borrows a colleague's
//    connection. "Copy into HaiVE" makes a copy the whole team can download.
// Unlinking never deletes anything in the cloud.
@Injectable()
export class CustomerCloudService implements OnModuleInit {
  constructor(
    @InjectConnection() private db: Connection,
    private directory: CustomerDirectoryService,
    private workspace: CustomerWorkspaceService,
    private connections: CloudConnectionsService,
    private access: CloudAccessService,
    private audit: AuditService,
  ) {}

  async onModuleInit() {
    // One folder belongs to one customer; one file is attached to a customer once.
    await this.db.collection(CLOUD_FOLDERS_COLLECTION).createIndex({ organizationId: 1, provider: 1, folderId: 1 }, { unique: true }).catch(() => undefined);
    await this.db.collection(CLOUD_FOLDERS_COLLECTION).createIndex({ organizationId: 1, customerKeys: 1 }).catch(() => undefined);
    await this.db.collection(CLOUD_LINKS_COLLECTION).createIndex({ organizationId: 1, customerKeys: 1 }).catch(() => undefined);
    await this.db.collection(CLOUD_LINKS_COLLECTION).createIndex({ organizationId: 1, provider: 1, fileId: 1 }).catch(() => undefined);
  }

  private log(caller: JwtPayload, action: string, customerId: string, metadata: Record<string, unknown>) {
    void this.audit.log({
      userId: caller.sub,
      organizationId: caller.organizationId,
      method: 'ACTION',
      route: `/customers/${customerId}/cloud`,
      statusCode: 200,
      durationMs: 0,
      action,
      metadata,
    });
  }

  private objectId(id: string, what: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`${what} not found.`);
    return new Types.ObjectId(id);
  }

  private async customer(caller: JwtPayload, customerId: string) {
    return this.directory.identity(caller.organizationId, customerId);
  }

  private theirs(organizationId: string, keys: string[]) {
    return { organizationId, customerKeys: { $in: keys } };
  }

  private async names(organizationId: string, ids: string[]): Promise<Map<string, string>> {
    const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (valid.length === 0) return new Map();
    const users = await this.db.collection('users').find({ _id: { $in: valid }, organizationId }, { projection: { name: 1, email: 1 } }).toArray();
    return new Map(users.map((u) => [u._id.toString(), text(u.name) || text(u.email) || 'Team member']));
  }

  /** How the person asking would open something kept in `ref`, judged from HaiVE's own records. */
  private reach(caller: JwtPayload, ref: StoredRef, connection: CloudConnectionDocument | undefined, mine: CloudConnectionDocument[]): CloudReach {
    if (!connection) return 'disconnected';
    if (ref.ownership === 'company' || connection.userId === caller.sub) return connection.status === 'needs_reauth' ? 'reconnect' : 'open';
    return mine.some((c) => c.provider === ref.provider && c.ownership === 'personal' && c.status !== 'needs_reauth') ? 'own_account' : 'disconnected';
  }

  // ---- what the panel shows ------------------------------------------------------------------

  async overview(caller: JwtPayload, customerId: string): Promise<{ folders: CustomerCloudFolder[]; links: CustomerCloudLink[]; categories: readonly string[]; subfolders: typeof CUSTOMER_SUBFOLDERS }> {
    const customer = await this.customer(caller, customerId);
    const filter = this.theirs(caller.organizationId, customer.keys);
    const [folders, links, mine] = await Promise.all([
      this.db.collection(CLOUD_FOLDERS_COLLECTION).find(filter).sort({ createdAt: 1 }).limit(20).toArray(),
      this.db.collection(CLOUD_LINKS_COLLECTION).find(filter).sort({ attachedAt: -1 }).limit(MAX_LINKS_PER_CUSTOMER).toArray(),
      this.connections.usable(caller),
    ]);
    const ids = [...new Set([...folders, ...links].map((d) => text(d.connectionId)))].filter((id) => Types.ObjectId.isValid(id));
    const stored = ids.length ? await this.connectionsById(caller.organizationId, ids) : new Map<string, CloudConnectionDocument>();
    const names = await this.names(caller.organizationId, [...folders, ...links].map((d) => text(d.connectionUserId)));
    const admin = this.workspace.canManage(caller);
    return {
      folders: folders.map((d) => {
        const ref = d as unknown as StoredRef;
        const connection = stored.get(text(d.connectionId));
        return {
          id: d._id.toString(),
          provider: d.provider,
          ownership: d.ownership,
          folderId: text(d.folderId),
          name: text(d.name),
          webUrl: text(d.webUrl) || undefined,
          ownerName: d.ownership === 'personal' ? names.get(text(d.connectionUserId)) : undefined,
          accountEmail: connection?.accountEmail,
          subfolders: Array.isArray(d.subfolders) ? d.subfolders : [],
          linkedBy: text(d.linkedByName) || 'Team member',
          at: d.createdAt,
          reach: this.reach(caller, ref, connection, mine),
          canUnlink: admin || text(d.linkedBy) === caller.sub,
          ...(d.indexedAt ? { indexedAt: d.indexedAt, indexedCount: typeof d.indexedCount === 'number' ? d.indexedCount : undefined } : {}),
        };
      }),
      links: links.map((d) => this.link(d, caller, stored, mine, names, admin)),
      categories: DOCUMENT_CATEGORIES,
      subfolders: CUSTOMER_SUBFOLDERS,
    };
  }

  private async connectionsById(organizationId: string, ids: string[]): Promise<Map<string, CloudConnectionDocument>> {
    const found = await Promise.all(ids.map((id) => this.connections.find(organizationId, id).catch(() => undefined)));
    return new Map(found.filter((c): c is CloudConnectionDocument => !!c).map((c) => [c._id.toString(), c]));
  }

  private link(d: Doc, caller: JwtPayload, stored: Map<string, CloudConnectionDocument>, mine: CloudConnectionDocument[], names: Map<string, string>, admin: boolean): CustomerCloudLink {
    return {
      id: d._id.toString(),
      provider: d.provider,
      ownership: d.ownership,
      fileId: text(d.fileId),
      name: text(d.name),
      mimeType: text(d.mimeType) || undefined,
      size: typeof d.size === 'number' ? d.size : undefined,
      modifiedAt: d.modifiedAt,
      webUrl: text(d.webUrl) || undefined,
      location: text(d.location) || undefined,
      category: DOCUMENT_CATEGORIES.includes(d.category) ? d.category : 'other',
      ...(d.linkedTo?.id ? { linkedTo: { kind: 'quotation' as const, id: text(d.linkedTo.id), label: text(d.linkedTo.label) } } : {}),
      attachedBy: text(d.attachedByName) || 'Team member',
      at: d.attachedAt,
      status: ['available', 'moved', 'deleted', 'no_access'].includes(d.status) ? d.status : 'available',
      ownerName: d.ownership === 'personal' ? names.get(text(d.connectionUserId)) : undefined,
      reach: this.reach(caller, d as unknown as StoredRef, stored.get(text(d.connectionId)), mine),
      canRemove: admin || text(d.attachedBy) === caller.sub,
    };
  }

  // ---- reaching what is kept -------------------------------------------------------------------

  /**
   * The account to open a stored folder or file with, for the person asking: the company account
   * (they may open the customer), their own account when it is theirs, or else their own account of
   * the same provider — which works only if the owner shared the item with them.
   */
  private async open(caller: JwtPayload, ref: StoredRef, itemId: string): Promise<CloudScope> {
    const label = CLOUD_PROVIDER_LABEL[ref.provider];
    const connection = await this.connections.find(caller.organizationId, ref.connectionId).catch(() => undefined);
    if (ref.ownership === 'company') {
      if (!connection) throw new CloudError('not_found', `The company ${label} this was in has been disconnected.`);
      return { connection, all: true, grants: [] };
    }
    if (connection && connection.userId === caller.sub) return { connection, all: true, grants: [] };
    const mine = (await this.connections.usable(caller)).filter((c) => c.provider === ref.provider && c.ownership === 'personal' && c.userId === caller.sub);
    const owner = (await this.names(caller.organizationId, [ref.connectionUserId])).get(ref.connectionUserId) ?? 'a colleague';
    for (const candidate of mine) {
      const provider = this.connections.provider(candidate.provider);
      const reachable = await this.connections.withToken(candidate, (token) => provider.get(token, itemId)).then(
        () => true,
        () => false,
      );
      if (reachable) return { connection: candidate, all: true, grants: [] };
    }
    throw new CloudError(
      'permission',
      mine.length === 0
        ? `This is in ${owner}’s ${label}. Connect your own ${label} (if ${owner} shared it with you), or open it in ${label}.`
        : `This is in ${owner}’s ${label}, and it isn’t shared with your ${label}. Ask ${owner} to share it with you.`,
    );
  }

  /** Throws unless `itemId` is the customer's folder or inside it. */
  private async within(scope: CloudScope, rootId: string, itemId: string) {
    if (itemId === rootId) return;
    const chain = await this.access.chain(scope, itemId);
    if (!chain.includes(rootId)) throw new NotFoundException('That isn’t in this customer’s folder.');
  }

  private async folderOf(caller: JwtPayload, customerId: string, mappingId: string) {
    const customer = await this.customer(caller, customerId);
    const doc = await this.db
      .collection(CLOUD_FOLDERS_COLLECTION)
      .findOne({ _id: this.objectId(mappingId, 'Folder'), ...this.theirs(caller.organizationId, customer.keys) });
    if (!doc) throw new NotFoundException('That folder isn’t linked to this customer.');
    return { customer, doc, ref: doc as unknown as StoredRef & { folderId: string } };
  }

  // ---- folders -------------------------------------------------------------------------------

  private async saveFolder(caller: JwtPayload, customer: { id: string; keys: string[] }, connection: CloudConnectionDocument, folder: CloudItem, subfolders: { key: string; label: string; folderId: string }[]) {
    const existing = await this.db.collection(CLOUD_FOLDERS_COLLECTION).findOne({ organizationId: caller.organizationId, provider: connection.provider, folderId: folder.id });
    if (existing) {
      const ours = (existing.customerKeys as string[]).some((k) => customer.keys.includes(k));
      // The same folder linked twice to one customer (a retry, a double click) is one link.
      if (!ours) throw new ConflictException('That folder is already linked to another customer. Choose a different folder.');
      if (subfolders.length) await this.db.collection(CLOUD_FOLDERS_COLLECTION).updateOne({ _id: existing._id }, { $set: { subfolders } });
      return existing._id.toString();
    }
    const now = new Date();
    try {
      const { insertedId } = await this.db.collection(CLOUD_FOLDERS_COLLECTION).insertOne({
        organizationId: caller.organizationId,
        customerId: customer.id,
        customerKeys: customer.keys,
        connectionId: connection._id.toString(),
        connectionUserId: connection.userId,
        provider: connection.provider,
        ownership: connection.ownership,
        folderId: folder.id,
        name: folder.name,
        webUrl: folder.webUrl,
        subfolders,
        linkedBy: caller.sub,
        linkedByName: await this.workspace.nameOf(caller),
        createdAt: now,
        updatedAt: now,
      });
      return insertedId.toString();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('That folder was just linked to a customer. Refresh and try again.');
      throw err;
    }
  }

  /** Links a folder the person can open to the customer. Nothing is created or moved in the cloud. */
  async linkFolder(caller: JwtPayload, customerId: string, connectionId: string, folderId: string): Promise<CustomerCloudFolder> {
    const customer = await this.customer(caller, customerId);
    const scope = await this.access.open(caller, connectionId);
    await this.access.assert(scope, folderId, 'view');
    const provider = this.connections.provider(scope.connection.provider);
    const folder = await this.connections.withToken(scope.connection, (token) => provider.get(token, folderId));
    if (folder.kind !== 'folder') throw new BadRequestException('Choose a folder, not a file.');
    if (folder.root) throw new BadRequestException('Choose a folder rather than the whole drive.');
    const id = await this.saveFolder(caller, customer, scope.connection, folder, []);
    this.log(caller, 'customer.cloud_folder_link', customerId, { provider: scope.connection.provider, folderId: folder.id, name: folder.name });
    return (await this.overview(caller, customerId)).folders.find((f) => f.id === id)!;
  }

  /**
   * Makes a folder for the customer inside `parentId` (and, if asked, its Quotations / Invoices /
   * Contracts / Orders / General Documents folders) and links it. Only ever on this explicit request;
   * a retry finds the folders already made instead of making them again.
   */
  async createFolder(caller: JwtPayload, customerId: string, connectionId: string, parentId: string, rawName: string, withSubfolders: boolean): Promise<CustomerCloudFolder> {
    const customer = await this.customer(caller, customerId);
    const scope = await this.access.open(caller, connectionId);
    await this.access.assert(scope, parentId, 'edit');
    const name = cleanFileName(rawName, 120) || customer.name;
    if (!name) throw new BadRequestException('Give the folder a name.');
    const provider = this.connections.provider(scope.connection.provider);
    const { folder, subfolders } = await this.connections.withToken(scope.connection, async (token) => {
      const made = await provider.createFolder(token, parentId, name);
      const inside: { key: string; label: string; folderId: string }[] = [];
      if (withSubfolders) for (const sub of CUSTOMER_SUBFOLDERS) inside.push({ key: sub.key, label: sub.label, folderId: (await provider.createFolder(token, made.id, sub.label)).id });
      return { folder: made, subfolders: inside };
    });
    const id = await this.saveFolder(caller, customer, scope.connection, folder, subfolders);
    this.log(caller, 'customer.cloud_folder_create', customerId, { provider: scope.connection.provider, folderId: folder.id, name, subfolders: subfolders.length });
    return (await this.overview(caller, customerId)).folders.find((f) => f.id === id)!;
  }

  /** Stops showing the folder on the customer. Nothing in the cloud is touched. */
  async unlinkFolder(caller: JwtPayload, customerId: string, mappingId: string): Promise<void> {
    const { doc } = await this.folderOf(caller, customerId, mappingId);
    if (text(doc.linkedBy) !== caller.sub && !this.workspace.canManage(caller)) throw new ForbiddenException('Only the person who linked it, or an administrator, can unlink this folder.');
    await this.db.collection(CLOUD_FOLDERS_COLLECTION).deleteOne({ _id: doc._id });
    this.log(caller, 'customer.cloud_folder_unlink', customerId, { provider: doc.provider, folderId: doc.folderId, name: doc.name });
  }

  async browse(
    caller: JwtPayload,
    customerId: string,
    mappingId: string,
    options: { folderId?: string; cursor?: string; sort?: CloudSort; direction?: 'asc' | 'desc'; type?: CloudFileType },
  ): Promise<{ folder: CloudItem; items: CloudItem[]; cursor?: string; canEdit: boolean }> {
    const { ref } = await this.folderOf(caller, customerId, mappingId);
    const folderId = options.folderId || ref.folderId;
    const scope = await this.open(caller, ref, ref.folderId);
    await this.within(scope, ref.folderId, folderId);
    const provider = this.connections.provider(scope.connection.provider);
    const [folder, page] = await Promise.all([
      this.connections.withToken(scope.connection, (token) => provider.get(token, folderId)),
      this.connections.withToken(scope.connection, (token) => provider.list(token, folderId, options)),
    ]);
    // Whoever may open the customer may add documents to their folder.
    return { folder, ...page, canEdit: folder.canEdit !== false };
  }

  async search(caller: JwtPayload, customerId: string, mappingId: string, query: string, type?: CloudFileType): Promise<ListResult> {
    const { ref } = await this.folderOf(caller, customerId, mappingId);
    const scope = await this.open(caller, ref, ref.folderId);
    const provider = this.connections.provider(scope.connection.provider);
    const page = await this.connections.withToken(scope.connection, (token) => provider.search(token, { query, type, folderId: ref.folderId }));
    const inside = await Promise.all(page.items.map((item) => this.within(scope, ref.folderId, item.id).then(() => true, () => false)));
    const live = page.items.filter((_, i) => inside[i]);
    // Google searches one folder's own files only: what the last sync found deeper down is added (names and dates only).
    const words = query.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const indexed = words
      ? await this.db
          .collection(CLOUD_INDEX_COLLECTION)
          .find({ organizationId: caller.organizationId, mappingId, nameLower: { $regex: words } })
          .limit(100)
          .toArray()
      : [];
    const seen = new Set(live.map((i) => i.id));
    const deeper: CloudItem[] = indexed
      .filter((d) => !seen.has(String(d.itemId)) && (!type || fileTypeOf({ kind: d.kind === 'folder' ? 'folder' : 'file', name: String(d.name), mimeType: d.mimeType }) === type))
      .map((d) => ({
        id: String(d.itemId),
        name: String(d.name),
        kind: d.kind === 'folder' ? 'folder' : 'file',
        mimeType: d.mimeType,
        size: d.size,
        modifiedAt: d.modifiedAt ? new Date(d.modifiedAt).toISOString() : undefined,
        webUrl: d.webUrl,
        parentId: d.parentId,
      }));
    return { items: [...live, ...deeper], cursor: page.cursor };
  }

  async folderItem(caller: JwtPayload, customerId: string, mappingId: string, itemId: string, inline: boolean) {
    const { ref } = await this.folderOf(caller, customerId, mappingId);
    const scope = await this.open(caller, ref, ref.folderId);
    await this.within(scope, ref.folderId, itemId);
    return this.content(caller, customerId, scope, itemId, inline);
  }

  async folderPreview(caller: JwtPayload, customerId: string, mappingId: string, itemId: string) {
    const { ref } = await this.folderOf(caller, customerId, mappingId);
    const scope = await this.open(caller, ref, ref.folderId);
    await this.within(scope, ref.folderId, itemId);
    const provider = this.connections.provider(scope.connection.provider);
    return this.connections.withToken(scope.connection, async (token) => {
      const item = await provider.get(token, itemId);
      return { ...(await provider.preview(token, item)), item };
    });
  }

  async createSubfolder(caller: JwtPayload, customerId: string, mappingId: string, parentId: string, rawName: string): Promise<CloudItem> {
    const { ref } = await this.folderOf(caller, customerId, mappingId);
    const scope = await this.open(caller, ref, ref.folderId);
    await this.within(scope, ref.folderId, parentId);
    const name = cleanFileName(rawName, 120);
    if (!name) throw new BadRequestException('Give the folder a name.');
    const provider = this.connections.provider(scope.connection.provider);
    const folder = await this.connections.withToken(scope.connection, (token) => provider.createFolder(token, parentId, name));
    this.log(caller, 'cloud.folder_create', customerId, { provider: scope.connection.provider, parentId, folderId: folder.id, name });
    return folder;
  }

  /** Uploads a file into the customer's folder (or one of its folders), then deletes the temporary copy. */
  async upload(caller: JwtPayload, customerId: string, mappingId: string, parentId: string, file: Express.Multer.File | undefined): Promise<CloudItem> {
    try {
      if (!file?.path) throw new BadRequestException('Choose a file to upload.');
      const { ref } = await this.folderOf(caller, customerId, mappingId);
      const target = parentId || ref.folderId;
      const scope = await this.open(caller, ref, ref.folderId);
      await this.within(scope, ref.folderId, target);
      const name = cleanFileName(file.originalname);
      assertAcceptableFile(name);
      const provider = this.connections.provider(scope.connection.provider);
      const uploaded = await this.connections.withToken(scope.connection, (token) =>
        provider.upload(token, target, name, { path: file.path, size: file.size, mimeType: file.mimetype || 'application/octet-stream' }),
      );
      this.log(caller, 'cloud.upload', customerId, { provider: scope.connection.provider, parentId: target, itemId: uploaded.id, name: uploaded.name, size: file.size });
      return uploaded;
    } finally {
      if (file?.path) await fs.unlink(file.path).catch(() => undefined);
    }
  }

  // ---- single files attached to the customer ----------------------------------------------------

  private async linkedQuotation(caller: JwtPayload, customerId: string, quotationId?: string) {
    if (!quotationId) return undefined;
    // Not found unless the quotation really is this customer's.
    const { document } = await this.directory.quotation(caller.organizationId, customerId, quotationId);
    return { kind: 'quotation' as const, id: quotationId, label: document.number ? `Quotation ${document.number}` : (document.title ?? 'Quotation') };
  }

  private category(value: string | undefined): DocumentCategory {
    if (value === undefined) return 'other';
    if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(value)) throw new BadRequestException('That isn’t one of the document kinds.');
    return value as DocumentCategory;
  }

  /** Attaches cloud files the person can open to the customer, as links (the files stay where they are). */
  async attach(caller: JwtPayload, customerId: string, connectionId: string, fileIds: string[], category?: string, quotationId?: string): Promise<CustomerCloudLink[]> {
    const customer = await this.customer(caller, customerId);
    const wanted = [...new Set(fileIds)].slice(0, MAX_ATTACH_AT_ONCE);
    if (wanted.length === 0) throw new BadRequestException('Choose the files to attach.');
    const kind = this.category(category);
    const linkedTo = await this.linkedQuotation(caller, customerId, quotationId);
    const scope = await this.access.open(caller, connectionId);
    const filter = this.theirs(caller.organizationId, customer.keys);
    const count = await this.db.collection(CLOUD_LINKS_COLLECTION).countDocuments(filter);
    if (count + wanted.length > MAX_LINKS_PER_CUSTOMER) throw new BadRequestException(`A customer can have up to ${MAX_LINKS_PER_CUSTOMER} attached cloud files.`);
    const provider = this.connections.provider(scope.connection.provider);
    const attachedByName = await this.workspace.nameOf(caller);
    const added: string[] = [];
    for (const fileId of wanted) {
      await this.access.assert(scope, fileId, 'view');
      const { item, path } = await this.connections.withToken(scope.connection, async (token) => {
        const found = await provider.get(token, fileId);
        return { item: found, path: found.root ? [] : await provider.ancestors(token, fileId) };
      });
      if (item.kind !== 'file') throw new BadRequestException(`“${item.name}” is a folder — link it as the customer’s folder instead.`);
      const existing = await this.db.collection(CLOUD_LINKS_COLLECTION).findOne({ ...filter, provider: scope.connection.provider, fileId: item.id });
      if (existing) {
        added.push(existing._id.toString());
        continue;
      }
      const { insertedId } = await this.db.collection(CLOUD_LINKS_COLLECTION).insertOne({
        organizationId: caller.organizationId,
        customerId: customer.id,
        customerKeys: customer.keys,
        connectionId: scope.connection._id.toString(),
        connectionUserId: scope.connection.userId,
        provider: scope.connection.provider,
        ownership: scope.connection.ownership,
        fileId: item.id,
        parentId: item.parentId,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        modifiedAt: item.modifiedAt ? new Date(item.modifiedAt) : undefined,
        webUrl: item.webUrl,
        location: [...path].reverse().map((p) => p.name).join(' / '),
        category: kind,
        ...(linkedTo ? { linkedTo } : {}),
        status: 'available',
        attachedBy: caller.sub,
        attachedByName,
        attachedAt: new Date(),
        lastCheckedAt: new Date(),
      });
      added.push(insertedId.toString());
    }
    this.log(caller, 'customer.cloud_file_attach', customerId, { provider: scope.connection.provider, files: wanted.length, category: kind });
    const links = (await this.overview(caller, customerId)).links;
    return links.filter((l) => added.includes(l.id));
  }

  private async linkOf(caller: JwtPayload, customerId: string, linkId: string) {
    const customer = await this.customer(caller, customerId);
    const doc = await this.db.collection(CLOUD_LINKS_COLLECTION).findOne({ _id: this.objectId(linkId, 'File'), ...this.theirs(caller.organizationId, customer.keys) });
    if (!doc) throw new NotFoundException('That file isn’t attached to this customer.');
    return doc;
  }

  async updateLink(caller: JwtPayload, customerId: string, linkId: string, change: { category?: string; quotationId?: string | null }): Promise<CustomerCloudLink> {
    const doc = await this.linkOf(caller, customerId, linkId);
    const set: Doc = {};
    const unset: Doc = {};
    if (change.category !== undefined) set.category = this.category(change.category);
    if (change.quotationId === null) unset.linkedTo = '';
    else if (change.quotationId !== undefined) set.linkedTo = await this.linkedQuotation(caller, customerId, change.quotationId);
    await this.db.collection(CLOUD_LINKS_COLLECTION).updateOne({ _id: doc._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    return (await this.overview(caller, customerId)).links.find((l) => l.id === linkId)!;
  }

  /** Takes the file off the customer. The file itself stays in the cloud. */
  async removeLink(caller: JwtPayload, customerId: string, linkId: string): Promise<void> {
    const doc = await this.linkOf(caller, customerId, linkId);
    if (text(doc.attachedBy) !== caller.sub && !this.workspace.canManage(caller)) throw new ForbiddenException('Only the person who attached it, or an administrator, can remove this file.');
    await this.db.collection(CLOUD_LINKS_COLLECTION).deleteOne({ _id: doc._id });
    this.log(caller, 'customer.cloud_file_detach', customerId, { provider: doc.provider, fileId: doc.fileId, name: doc.name });
  }

  private async content(caller: JwtPayload, customerId: string, scope: CloudScope, itemId: string, inline: boolean) {
    const provider = this.connections.provider(scope.connection.provider);
    const file = await this.connections.withToken(scope.connection, async (token) => {
      if (!inline) return provider.download(token, itemId);
      const item = await provider.get(token, itemId);
      const preview = await provider.preview(token, item);
      if (preview.kind !== 'inline' && preview.kind !== 'pdf') throw new CloudError('bad_request', 'This file can’t be shown here. Download it or open it in its own app.');
      return provider.download(token, itemId, preview.kind === 'pdf' ? 'pdf' : 'original');
    });
    if (inline && !inlineType(file.mimeType)) {
      file.stream.destroy();
      throw new CloudError('bad_request', 'This file can’t be shown here. Download it instead.');
    }
    if (!inline) this.log(caller, 'cloud.download', customerId, { provider: scope.connection.provider, itemId, name: file.name });
    return file;
  }

  /** Opens an attached file — and keeps its status true to what the provider says. */
  async linkContent(caller: JwtPayload, customerId: string, linkId: string, inline: boolean) {
    const doc = await this.linkOf(caller, customerId, linkId);
    const ref = doc as unknown as StoredRef;
    try {
      const scope = await this.open(caller, ref, text(doc.fileId));
      const file = await this.content(caller, customerId, scope, text(doc.fileId), inline);
      if (doc.status !== 'available') await this.db.collection(CLOUD_LINKS_COLLECTION).updateOne({ _id: doc._id }, { $set: { status: 'available', lastCheckedAt: new Date() } });
      return file;
    } catch (err) {
      // Gone from the account it was attached from: said on the customer from now on.
      if (err instanceof CloudError && err.kind === 'not_found' && (ref.ownership === 'company' || text(doc.connectionUserId) === caller.sub))
        await this.db.collection(CLOUD_LINKS_COLLECTION).updateOne({ _id: doc._id }, { $set: { status: 'deleted', lastCheckedAt: new Date() } });
      throw err;
    }
  }

  async linkPreview(caller: JwtPayload, customerId: string, linkId: string) {
    const doc = await this.linkOf(caller, customerId, linkId);
    const scope = await this.open(caller, doc as unknown as StoredRef, text(doc.fileId));
    const provider = this.connections.provider(scope.connection.provider);
    return this.connections.withToken(scope.connection, async (token) => {
      const item = await provider.get(token, text(doc.fileId));
      return { ...(await provider.preview(token, item)), item };
    });
  }

  /** Copies an attached cloud file into HaiVE's own files for the customer — a copy the whole team can download. */
  async copyIntoHaive(caller: JwtPayload, customerId: string, linkId: string): Promise<CustomerFile> {
    const doc = await this.linkOf(caller, customerId, linkId);
    const file = await this.linkContent(caller, customerId, linkId, false);
    const buffer = await this.read(file.stream, UPLOAD_FILE_SIZE_LIMIT_BYTES);
    const saved = await this.workspace.addFile(caller, customerId, { buffer, originalname: file.name, mimetype: file.mimeType, size: buffer.length } as Express.Multer.File);
    // Where the copy came from, so the page can say so.
    await this.db
      .collection(`${FILES_BUCKET}.files`)
      .updateOne({ _id: new Types.ObjectId(saved.id) }, { $set: { 'metadata.copiedFrom': { provider: doc.provider, fileId: doc.fileId, name: doc.name, webUrl: doc.webUrl } } });
    this.log(caller, 'customer.cloud_file_copy', customerId, { provider: doc.provider, fileId: doc.fileId, name: doc.name, haiveFileId: saved.id });
    return saved;
  }

  private async read(stream: Readable, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > limit) {
        stream.destroy();
        throw new BadRequestException(`Files over ${Math.round(limit / (1024 * 1024))} MB can’t be copied into HaiVE. Keep it as a link instead.`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  // ---- HaiVE's own customer files, across customers (the Files page) ----------------------------

  async haiveFiles(caller: JwtPayload): Promise<HaiveCustomerFile[]> {
    const docs = await this.db
      .collection(`${FILES_BUCKET}.files`)
      .find({ 'metadata.organizationId': caller.organizationId })
      .sort({ uploadDate: -1 })
      .limit(200)
      .toArray();
    // Each file under the customer its keys belong to today (a sync can merge or split rows).
    const owners = await this.directory.customerIds(caller.organizationId);
    const named = new Map<string, string>();
    const out: HaiveCustomerFile[] = [];
    for (const doc of docs) {
      const meta = (doc.metadata ?? {}) as Doc;
      const customerId = ((meta.customerKeys as string[] | undefined) ?? []).map((k) => owners.get(k)).find(Boolean);
      if (!customerId) continue;
      if (!named.has(customerId)) named.set(customerId, await this.directory.identity(caller.organizationId, customerId).then((c) => c.name, () => 'Customer'));
      out.push({
        id: doc._id.toString(),
        customerId,
        customerName: named.get(customerId)!,
        name: text(doc.filename) || 'File',
        size: typeof doc.length === 'number' ? doc.length : 0,
        type: text(meta.contentType) || 'application/octet-stream',
        uploadedBy: text(meta.uploadedByName) || 'Team member',
        at: doc.uploadDate,
        ...(meta.copiedFrom?.provider === 'google_drive' || meta.copiedFrom?.provider === 'onedrive' ? { copiedFrom: meta.copiedFrom.provider as CloudProviderId } : {}),
      });
    }
    return out;
  }
}
