import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { promises as fs } from 'fs';
import { Model } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { assertAcceptableFile, cleanFileName } from '../common/file-names';
import { CloudAccessService, CloudScope } from './cloud-access.service';
import { CloudConnectionsService, isOrgAdmin } from './cloud-connections.service';
import { CloudError } from './cloud-http';
import {
  CLOUD_PROVIDER_LABEL,
  CloudDownload,
  CloudFileType,
  CloudItem,
  CloudPreview,
  CloudSort,
  inlineType,
  ListResult,
  ROOT_REF,
  SHARED_REF,
} from './cloud-files.types';
import { CloudFolderGrant, CloudFolderGrantDocument } from './schemas/cloud-folder-grant.schema';

// The roles a company folder can be opened to. Owners and admins always see the whole company account.
export const GRANTABLE_ROLES = ['manager', 'consultant', 'user', 'agent_user'] as const;
const MAX_GRANTS = 100;

export interface CloudFolderListing extends ListResult {
  folder: CloudItem;
  /** May the person asking add to / change things in this folder? */
  canEdit: boolean;
}

export interface CloudFolderGrantView {
  folderId: string;
  name: string;
  path: string;
  roles: string[];
  access: 'view' | 'edit';
}

const isVirtual = (id: string) => id === ROOT_REF || id === SHARED_REF;

// Browsing and changing the files of a connected Google Drive / OneDrive account,
// for the person asking: every call opens the connection through the access
// policy (cloud-access.service.ts) first, and every change is written to the
// audit log with what was changed.
@Injectable()
export class CloudFilesService {
  constructor(
    private connections: CloudConnectionsService,
    private access: CloudAccessService,
    private audit: AuditService,
    @InjectModel(CloudFolderGrant.name) private grants: Model<CloudFolderGrantDocument>,
  ) {}

  private provider(scope: CloudScope) {
    return this.connections.provider(scope.connection.provider);
  }

  private label(scope: CloudScope) {
    return CLOUD_PROVIDER_LABEL[scope.connection.provider];
  }

  private log(caller: JwtPayload, action: string, scope: CloudScope, metadata: Record<string, unknown>) {
    void this.audit.log({
      userId: caller.sub,
      organizationId: caller.organizationId,
      method: 'ACTION',
      route: `/cloud-files/connections/${scope.connection._id.toString()}`,
      statusCode: 200,
      durationMs: 0,
      action,
      metadata: { provider: scope.connection.provider, ownership: scope.connection.ownership, account: scope.connection.accountEmail, ...metadata },
    });
  }

  /** Where browsing starts: the account's own starting points, or for a granted role the folders opened to it. */
  async roots(caller: JwtPayload, connectionId: string): Promise<CloudItem[]> {
    const scope = await this.access.open(caller, connectionId);
    if (!scope.all)
      return scope.grants.map((g) => ({ id: g.folderId, name: g.name, kind: 'folder', root: true, canEdit: g.access === 'edit' }) satisfies CloudItem);
    return this.connections.withToken(scope.connection, (token) => this.provider(scope).roots(token));
  }

  async list(
    caller: JwtPayload,
    connectionId: string,
    folderId: string,
    options: { cursor?: string; sort?: CloudSort; direction?: 'asc' | 'desc'; type?: CloudFileType; foldersOnly?: boolean },
  ): Promise<CloudFolderListing> {
    const scope = await this.access.open(caller, connectionId);
    if (!scope.all && isVirtual(folderId)) throw new ForbiddenException('Open one of the folders shared with your role.');
    await this.access.assert(scope, folderId, 'view');
    const provider = this.provider(scope);
    const [folder, page, canEdit] = await Promise.all([
      this.connections.withToken(scope.connection, (token) => provider.get(token, folderId)),
      this.connections.withToken(scope.connection, (token) => provider.list(token, folderId, options)),
      this.access.canEdit(scope, folderId),
    ]);
    if (folder.kind !== 'folder') throw new BadRequestException('That is a file, not a folder.');
    return { folder: { ...folder, canEdit: folderId === SHARED_REF ? false : canEdit && folder.canEdit !== false }, ...page, canEdit: folderId !== SHARED_REF && canEdit };
  }

  async search(
    caller: JwtPayload,
    connectionId: string,
    options: { query: string; type?: CloudFileType; modifiedAfter?: Date; folderId?: string; cursor?: string },
  ): Promise<ListResult> {
    const scope = await this.access.open(caller, connectionId);
    if (options.folderId && !isVirtual(options.folderId)) await this.access.assert(scope, options.folderId, 'view');
    const page = await this.connections.withToken(scope.connection, (token) => this.provider(scope).search(token, options));
    // Across a company account, only what is below the folders opened to their role.
    return { items: await this.access.visible(scope, page.items), cursor: page.cursor };
  }

  /** One item, and with `withPath` the folders above it as the person may follow them. */
  async item(caller: JwtPayload, connectionId: string, itemId: string, withPath = false): Promise<{ item: CloudItem; path?: CloudItem[] }> {
    const scope = await this.access.open(caller, connectionId);
    await this.access.assert(scope, itemId, 'view');
    const provider = this.provider(scope);
    const item = await this.connections.withToken(scope.connection, (token) => provider.get(token, itemId));
    if (!withPath || item.root) return { item, ...(withPath ? { path: [] } : {}) };
    const ancestors = await this.connections.withToken(scope.connection, (token) => provider.ancestors(token, itemId));
    return { item, path: await this.access.trim(scope, [...ancestors].reverse()) };
  }

  async preview(caller: JwtPayload, connectionId: string, itemId: string): Promise<CloudPreview & { item: CloudItem }> {
    const scope = await this.access.open(caller, connectionId);
    await this.access.assert(scope, itemId, 'view');
    const provider = this.provider(scope);
    return this.connections.withToken(scope.connection, async (token) => {
      const item = await provider.get(token, itemId);
      return { ...(await provider.preview(token, item)), item };
    });
  }

  /**
   * The file's content. `inline` is for looking at it in the page: only what is safe to show as it is
   * (an image, a PDF, plain text) or a PDF made from a Google document.
   */
  async download(caller: JwtPayload, connectionId: string, itemId: string, inline = false): Promise<CloudDownload> {
    const scope = await this.access.open(caller, connectionId);
    await this.access.assert(scope, itemId, 'view');
    const provider = this.provider(scope);
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
    if (!inline) this.log(caller, 'cloud.download', scope, { itemId, name: file.name });
    return file;
  }

  private folderName(raw: string): string {
    const name = cleanFileName(raw, 120);
    if (!name || name === '.' || name === '..') throw new BadRequestException('Give the folder a name.');
    return name;
  }

  async createFolder(caller: JwtPayload, connectionId: string, parentId: string, rawName: string): Promise<CloudItem> {
    const scope = await this.access.open(caller, connectionId);
    if (parentId === SHARED_REF) throw new BadRequestException('Choose a folder of your own to add a folder to.');
    await this.access.assert(scope, parentId, 'edit');
    const name = this.folderName(rawName);
    const folder = await this.connections.withToken(scope.connection, (token) => this.provider(scope).createFolder(token, parentId, name));
    this.log(caller, 'cloud.folder_create', scope, { parentId, folderId: folder.id, name });
    return folder;
  }

  async update(caller: JwtPayload, connectionId: string, itemId: string, change: { name?: string; parentId?: string }): Promise<CloudItem> {
    const scope = await this.access.open(caller, connectionId);
    if (isVirtual(itemId)) throw new BadRequestException('That can’t be renamed or moved.');
    if (change.name === undefined && change.parentId === undefined) throw new BadRequestException('Nothing to change.');
    await this.access.assert(scope, itemId, 'edit');
    if (change.parentId !== undefined) {
      if (change.parentId === SHARED_REF) throw new BadRequestException('Choose one of your own folders to move it to.');
      if (change.parentId === itemId) throw new BadRequestException('A folder can’t be moved into itself.');
      await this.access.assert(scope, change.parentId, 'edit');
    }
    const provider = this.provider(scope);
    return this.connections.withToken(scope.connection, async (token) => {
      const before = await provider.get(token, itemId);
      let name: string | undefined;
      if (change.name !== undefined) {
        name = before.kind === 'folder' ? this.folderName(change.name) : cleanFileName(change.name);
        if (before.kind === 'file') assertAcceptableFile(name);
      }
      if (change.parentId !== undefined && before.kind === 'folder') {
        // Never into one of its own folders.
        const target = await this.access.chain(scope, change.parentId);
        if (target.includes(itemId)) throw new BadRequestException('A folder can’t be moved into one of its own folders.');
      }
      const after = await provider.update(token, itemId, { name, parentId: change.parentId });
      this.access.forget(scope, itemId);
      if (name !== undefined && name !== before.name) this.log(caller, 'cloud.rename', scope, { itemId, from: before.name, to: name });
      if (change.parentId !== undefined && change.parentId !== before.parentId)
        this.log(caller, 'cloud.move', scope, { itemId, name: after.name, from: before.parentId, to: change.parentId });
      return after;
    });
  }

  async remove(caller: JwtPayload, connectionId: string, itemId: string): Promise<void> {
    const scope = await this.access.open(caller, connectionId);
    if (isVirtual(itemId) || (!scope.all && scope.grants.some((g) => g.folderId === itemId)))
      throw new BadRequestException('That folder can’t be deleted from HaiVE.');
    await this.access.assert(scope, itemId, 'edit');
    const provider = this.provider(scope);
    await this.connections.withToken(scope.connection, async (token) => {
      const item = await provider.get(token, itemId);
      if (item.root) throw new BadRequestException('That folder can’t be deleted from HaiVE.');
      await provider.remove(token, itemId);
      this.access.forget(scope, itemId);
      this.log(caller, 'cloud.delete', scope, { itemId, name: item.name, kind: item.kind });
    });
  }

  /** Sends one uploaded file (on disk) to a folder, then deletes the temporary copy whatever happened. */
  async upload(caller: JwtPayload, connectionId: string, parentId: string, file: Express.Multer.File | undefined): Promise<CloudItem> {
    try {
      if (!file?.path) throw new BadRequestException('Choose a file to upload.');
      const scope = await this.access.open(caller, connectionId);
      if (!parentId || parentId === SHARED_REF) throw new BadRequestException('Choose the folder to upload to.');
      await this.access.assert(scope, parentId, 'edit');
      const name = cleanFileName(file.originalname);
      assertAcceptableFile(name);
      const uploaded = await this.connections.withToken(scope.connection, (token) =>
        this.provider(scope).upload(token, parentId, name, { path: file.path, size: file.size, mimeType: file.mimetype || 'application/octet-stream' }),
      );
      this.log(caller, 'cloud.upload', scope, { parentId, itemId: uploaded.id, name: uploaded.name, size: file.size });
      return uploaded;
    } finally {
      if (file?.path) await fs.unlink(file.path).catch(() => undefined);
    }
  }

  // ---- company account: which folders each role may open ------------------------------

  private async companyScope(caller: JwtPayload, connectionId: string): Promise<CloudScope> {
    if (!isOrgAdmin(caller)) throw new ForbiddenException('Only an owner or admin can share company folders.');
    const scope = await this.access.open(caller, connectionId);
    if (scope.connection.ownership !== 'company') throw new BadRequestException('Folders are shared from the company account only.');
    return scope;
  }

  async listGrants(caller: JwtPayload, connectionId: string): Promise<CloudFolderGrantView[]> {
    const scope = await this.companyScope(caller, connectionId);
    const grants = await this.grants.find({ organizationId: caller.organizationId, connectionId: scope.connection._id.toString() }).sort({ path: 1 }).exec();
    return grants.map((g) => ({ folderId: g.folderId, name: g.name, path: g.path, roles: g.roles, access: g.access }));
  }

  /** Replaces the folders shared from the company account. Each folder is checked with the provider first. */
  async setGrants(
    caller: JwtPayload,
    connectionId: string,
    wanted: { folderId: string; roles: string[]; access: 'view' | 'edit' }[],
  ): Promise<CloudFolderGrantView[]> {
    const scope = await this.companyScope(caller, connectionId);
    if (wanted.length > MAX_GRANTS) throw new BadRequestException(`Share up to ${MAX_GRANTS} folders.`);
    const seen = new Set<string>();
    const provider = this.provider(scope);
    const rows: (CloudFolderGrantView & { organizationId: string; connectionId: string; grantedBy: string })[] = [];
    for (const grant of wanted) {
      if (seen.has(grant.folderId)) continue;
      seen.add(grant.folderId);
      if (isVirtual(grant.folderId)) throw new BadRequestException(`Share folders of the ${this.label(scope)} rather than the whole drive.`);
      const roles = [...new Set(grant.roles)].filter((r) => (GRANTABLE_ROLES as readonly string[]).includes(r));
      if (roles.length === 0) continue;
      const { folder, path } = await this.connections.withToken(scope.connection, async (token) => {
        const item = await provider.get(token, grant.folderId);
        const above = item.root ? [] : await provider.ancestors(token, grant.folderId);
        return { folder: item, path: [...above].reverse().map((a) => a.name) };
      });
      if (folder.kind !== 'folder') throw new BadRequestException(`“${folder.name}” is a file — share a folder.`);
      if (folder.root) throw new BadRequestException(`Share folders of the ${this.label(scope)} rather than the whole drive.`);
      rows.push({
        organizationId: caller.organizationId,
        connectionId: scope.connection._id.toString(),
        folderId: folder.id,
        name: folder.name,
        path: [...path, folder.name].join(' / '),
        roles,
        access: grant.access === 'edit' ? ('edit' as const) : ('view' as const),
        grantedBy: caller.sub,
      });
    }
    const before = await this.listGrants(caller, connectionId);
    await this.grants.deleteMany({ organizationId: caller.organizationId, connectionId: scope.connection._id.toString() }).exec();
    if (rows.length > 0) await this.grants.insertMany(rows);
    const after = await this.listGrants(caller, connectionId);
    this.log(caller, 'cloud.grant_change', scope, {
      before: before.map((g) => ({ path: g.path, roles: g.roles, access: g.access })),
      after: after.map((g) => ({ path: g.path, roles: g.roles, access: g.access })),
    });
    return after;
  }
}
