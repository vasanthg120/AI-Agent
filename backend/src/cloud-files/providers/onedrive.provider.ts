import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { cloudRequest, CloudError } from '../cloud-http';
import {
  CloudAccount,
  CloudDownload,
  CloudItem,
  CloudPreview,
  CloudProvider,
  CloudTokens,
  fileTypeOf,
  inlineType,
  ListOptions,
  ListResult,
  ROOT_REF,
  SearchOptions,
  SHARED_REF,
  sortPage,
  UploadSource,
} from '../cloud-files.types';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LABEL = 'OneDrive';
// "common": Microsoft 365 work and school accounts, and personal Microsoft accounts where the app registration allows them.
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = 'offline_access User.Read Files.ReadWrite.All';
const SELECT = 'id,name,size,lastModifiedDateTime,createdDateTime,webUrl,folder,file,parentReference,remoteItem,createdBy,shared';
const PAGE_SIZE = 100;
// Small files go up in one request; larger ones through an upload session, in pieces that are a multiple of 320 KiB.
const SIMPLE_UPLOAD_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 32 * 320 * 1024;
const ANCESTOR_DEPTH = 25;
const OFFICE_PREVIEW = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'vsdx']);

// An item lives in a drive (yours, or a colleague's that was shared with you), so HaiVE's id for it carries both.
const ref = (driveId: string, itemId: string) => Buffer.from(`${driveId}|${itemId}`, 'utf8').toString('base64url');
function parseRef(id: string): { driveId: string; itemId: string } {
  const decoded = /^[A-Za-z0-9_-]{4,600}$/.test(id) ? Buffer.from(id, 'base64url').toString('utf8') : '';
  const [driveId, itemId, extra] = decoded.split('|');
  if (!driveId || !itemId || extra !== undefined || /[/\\?#]/.test(driveId + itemId)) throw new CloudError('not_found', 'That item isn’t in OneDrive.');
  return { driveId, itemId };
}

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  webUrl?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  parentReference?: { driveId?: string; id?: string; path?: string };
  remoteItem?: GraphItem;
  createdBy?: { user?: { displayName?: string } };
  shared?: unknown;
}

@Injectable()
export class OneDriveProvider implements CloudProvider {
  readonly id = 'onedrive' as const;

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private setting(key: 'clientId' | 'clientSecret' | 'redirectUri'): string {
    return this.config.get<string>(`cloudFiles.microsoft.${key}`) ?? '';
  }

  configured(): boolean {
    return !!this.setting('clientId') && !!this.setting('clientSecret');
  }

  permissions(scope: string): string[] {
    const granted = scope.split(/\s+/).map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase());
    return [
      ...(granted.includes('files.readwrite.all') ? ['Read, add and change the files you can open in OneDrive'] : []),
      ...(granted.includes('user.read') ? ['Your name and email address'] : []),
      ...(granted.includes('offline_access') ? ['Stay connected until you disconnect'] : []),
    ];
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.setting('clientId'),
      response_type: 'code',
      redirect_uri: this.setting('redirectUri'),
      response_mode: 'query',
      scope: SCOPES,
      prompt: 'select_account',
      state,
    });
    return `${AUTHORITY}/authorize?${params.toString()}`;
  }

  private async token(body: Record<string, string>): Promise<CloudTokens> {
    const { data } = await cloudRequest<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(this.http, LABEL, {
      method: 'post',
      url: `${AUTHORITY}/token`,
      data: new URLSearchParams({ client_id: this.setting('clientId'), client_secret: this.setting('clientSecret'), scope: SCOPES, ...body }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in, scope: data.scope ?? '' };
  }

  exchangeCode(code: string): Promise<CloudTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.setting('redirectUri') });
  }

  refresh(refreshToken: string): Promise<CloudTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async account(accessToken: string): Promise<CloudAccount> {
    const [me, drive] = await Promise.all([
      this.call<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>(accessToken, {
        url: `${GRAPH}/me`,
        params: { $select: 'id,displayName,mail,userPrincipalName' },
      }),
      this.call<{ id: string }>(accessToken, { url: `${GRAPH}/me/drive`, params: { $select: 'id' } }),
    ]);
    let tenantId: string | undefined;
    try {
      // The `tid` claim of the token just received from Microsoft (nothing to verify: it came straight from the token endpoint).
      tenantId = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')).tid;
    } catch {
      tenantId = undefined;
    }
    return { accountId: me.id, email: me.mail ?? me.userPrincipalName ?? '', name: me.displayName, tenantId, driveId: drive.id };
  }

  // Microsoft has no endpoint that withdraws one app's delegated tokens for a user (only "sign out everywhere",
  // which would sign them out of every app). Disconnecting deletes HaiVE's copy; the user can also remove the
  // app from their Microsoft account's app permissions.
  async revoke(): Promise<void> {
    return;
  }

  private async call<T = any>(token: string, config: Parameters<typeof cloudRequest>[2]): Promise<T> {
    const { data } = await cloudRequest<T>(this.http, LABEL, { ...config, headers: { Authorization: `Bearer ${token}`, ...(config.headers ?? {}) } });
    return data;
  }

  private item(raw: GraphItem, root = false): CloudItem {
    // An entry in "Shared with me" points at the real item in its owner's drive.
    const target = raw.remoteItem ?? raw;
    const driveId = target.parentReference?.driveId ?? raw.parentReference?.driveId ?? '';
    const parent = target.parentReference?.id;
    return {
      id: ref(driveId, target.id),
      name: raw.name ?? target.name,
      kind: target.folder || raw.folder ? 'folder' : 'file',
      mimeType: target.file?.mimeType ?? raw.file?.mimeType,
      size: target.folder || raw.folder ? undefined : (target.size ?? raw.size),
      modifiedAt: target.lastModifiedDateTime ?? raw.lastModifiedDateTime,
      createdAt: target.createdDateTime ?? raw.createdDateTime,
      webUrl: target.webUrl ?? raw.webUrl,
      parentId: parent && driveId ? ref(driveId, parent) : undefined,
      owner: (target.createdBy ?? raw.createdBy)?.user?.displayName,
      shared: !!(target.shared ?? raw.shared ?? raw.remoteItem),
      ...(root ? { root: true } : {}),
    };
  }

  /** Where an item is in Graph's URL space. */
  private path(id: string): string {
    if (id === ROOT_REF) return `${GRAPH}/me/drive/root`;
    const { driveId, itemId } = parseRef(id);
    return `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
  }

  async roots(): Promise<CloudItem[]> {
    return [
      { id: ROOT_REF, name: 'My files', kind: 'folder', root: true, canEdit: true },
      { id: SHARED_REF, name: 'Shared with me', kind: 'folder', root: true, canEdit: false },
    ];
  }

  /** A next-page link Graph handed out — only ever followed back to Graph itself. */
  private nextPage(cursor: string): string {
    if (!cursor.startsWith(`${GRAPH}/`)) throw new CloudError('bad_request', 'That page of results has expired. Open the folder again.');
    return cursor;
  }

  private async page(token: string, url: string, params?: Record<string, unknown>): Promise<{ value: GraphItem[]; next?: string }> {
    const data = await this.call<{ value: GraphItem[]; '@odata.nextLink'?: string }>(token, { url, ...(params ? { params } : {}) });
    return { value: data.value ?? [], next: data['@odata.nextLink'] };
  }

  async list(token: string, folderId: string, options: ListOptions): Promise<ListResult> {
    const { value, next } = options.cursor
      ? await this.page(token, this.nextPage(options.cursor))
      : folderId === SHARED_REF
        ? await this.page(token, `${GRAPH}/me/drive/sharedWithMe`)
        : await this.page(token, `${this.path(folderId)}/children`, { $top: PAGE_SIZE, $select: SELECT });
    let items = value.map((v) => this.item(v));
    if (options.foldersOnly) items = items.filter((i) => i.kind === 'folder');
    else if (options.type) items = items.filter((i) => fileTypeOf(i) === options.type);
    // Graph can't order every listing on the server: each page is put in order here, folders first.
    return { items: sortPage(items, options.sort, options.direction), cursor: next };
  }

  async search(token: string, options: SearchOptions): Promise<ListResult> {
    const words = options.query.trim().replace(/'/g, "''");
    const base = options.folderId && options.folderId !== SHARED_REF ? this.path(options.folderId) : `${GRAPH}/me/drive/root`;
    const { value, next } = options.cursor
      ? await this.page(token, this.nextPage(options.cursor))
      : await this.page(token, `${base}/search(q='${encodeURIComponent(words)}')`, { $top: PAGE_SIZE, $select: SELECT });
    let items = value.map((v) => this.item(v));
    if (options.type) items = items.filter((i) => fileTypeOf(i) === options.type);
    if (options.modifiedAfter) items = items.filter((i) => !!i.modifiedAt && Date.parse(i.modifiedAt) > options.modifiedAfter!.getTime());
    return { items, cursor: next };
  }

  private async raw(token: string, id: string): Promise<GraphItem> {
    return this.call<GraphItem>(token, { url: this.path(id), params: { $select: SELECT } });
  }

  async get(token: string, id: string): Promise<CloudItem> {
    if (id === SHARED_REF) return { id: SHARED_REF, name: 'Shared with me', kind: 'folder', root: true };
    const raw = await this.raw(token, id);
    const isRoot = !raw.parentReference?.id;
    return { ...this.item(raw, isRoot), ...(isRoot ? { name: 'My files', id: id === ROOT_REF ? ROOT_REF : this.item(raw).id } : {}) };
  }

  async ancestors(token: string, id: string): Promise<CloudItem[]> {
    const chain: CloudItem[] = [];
    let current = await this.raw(token, id);
    for (let depth = 0; depth < ANCESTOR_DEPTH; depth++) {
      const parent = current.parentReference;
      if (!parent?.id || !parent.driveId) break;
      current = await this.raw(token, ref(parent.driveId, parent.id));
      const isRoot = !current.parentReference?.id;
      chain.push({ ...this.item(current, isRoot), ...(isRoot ? { name: 'My files' } : {}) });
    }
    return chain;
  }

  async download(token: string, id: string, as: 'original' | 'pdf' = 'original'): Promise<CloudDownload> {
    const raw = await this.raw(token, id);
    const item = this.item(raw);
    if (item.kind === 'folder') throw new CloudError('bad_request', 'A folder can’t be downloaded as one file.');
    // Graph answers with a redirect to a short-lived download address; the redirect is followed without our token.
    const { data } = await cloudRequest<Readable>(this.http, LABEL, {
      url: `${this.path(id)}/content`,
      params: as === 'pdf' ? { format: 'pdf' } : undefined,
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'stream',
      timeout: 120_000,
    });
    const name = as === 'pdf' && !item.name.toLowerCase().endsWith('.pdf') ? `${item.name.replace(/\.[^.]+$/, '')}.pdf` : item.name;
    return { stream: data, name, mimeType: as === 'pdf' ? 'application/pdf' : (item.mimeType ?? 'application/octet-stream'), size: as === 'pdf' ? undefined : item.size };
  }

  async preview(token: string, item: CloudItem): Promise<CloudPreview> {
    if (item.kind === 'folder') return { kind: 'none' };
    if (inlineType(item.mimeType)) return { kind: 'inline' };
    const extension = item.name.includes('.') ? item.name.split('.').pop()!.toLowerCase() : '';
    if (OFFICE_PREVIEW.has(extension)) {
      // A viewer page Microsoft hosts for a short while, which needs no sign-in to show.
      const data = await this.call<{ getUrl?: string }>(token, { method: 'post', url: `${this.path(item.id)}/preview`, data: {}, retry: true }).catch(
        () => ({}) as { getUrl?: string },
      );
      if (data.getUrl?.startsWith('https://')) return { kind: 'embed', url: data.getUrl };
    }
    return item.webUrl ? { kind: 'link', url: item.webUrl } : { kind: 'none' };
  }

  /** The child of `parentId` with that name, or undefined. */
  private async child(token: string, parentId: string, name: string): Promise<GraphItem | undefined> {
    try {
      return await this.call<GraphItem>(token, { url: `${this.path(parentId)}:/${encodeURIComponent(name)}`, params: { $select: SELECT } });
    } catch (err) {
      if (err instanceof CloudError && err.kind === 'not_found') return undefined;
      throw err;
    }
  }

  async createFolder(token: string, parentId: string, name: string): Promise<CloudItem> {
    const existing = await this.child(token, parentId, name);
    if (existing?.folder) return this.item(existing);
    if (existing) throw new CloudError('conflict', `A file called “${name}” is already in that folder.`);
    try {
      const created = await this.call<GraphItem>(token, {
        method: 'post',
        url: `${this.path(parentId)}/children`,
        data: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      });
      return this.item(created);
    } catch (err) {
      // Made by someone else (or a retry) a moment ago: that one is the folder.
      if (err instanceof CloudError && err.kind === 'conflict') {
        const made = await this.child(token, parentId, name);
        if (made?.folder) return this.item(made);
      }
      throw err;
    }
  }

  async update(token: string, id: string, change: { name?: string; parentId?: string }): Promise<CloudItem> {
    const body: Record<string, unknown> = {};
    if (change.name) body.name = change.name;
    if (change.parentId !== undefined) {
      if (change.parentId === ROOT_REF) {
        const root = await this.call<GraphItem>(token, { url: `${GRAPH}/me/drive/root`, params: { $select: 'id,parentReference' } });
        body.parentReference = { id: root.id };
      } else {
        const { driveId, itemId } = parseRef(change.parentId);
        if (driveId !== parseRef(id).driveId) throw new CloudError('bad_request', 'OneDrive can only move an item within the same drive.');
        body.parentReference = { id: itemId };
      }
    }
    const updated = await this.call<GraphItem>(token, { method: 'patch', url: this.path(id), data: body });
    return this.item(updated);
  }

  async remove(token: string, id: string): Promise<void> {
    await this.call(token, { method: 'delete', url: this.path(id) });
  }

  async upload(token: string, parentId: string, name: string, source: UploadSource): Promise<CloudItem> {
    const target = `${this.path(parentId)}:/${encodeURIComponent(name)}:`;
    if (source.size <= SIMPLE_UPLOAD_BYTES) {
      const content = await fs.readFile(source.path);
      const created = await this.call<GraphItem>(token, {
        method: 'put',
        url: `${target}/content`,
        params: { '@microsoft.graph.conflictBehavior': 'rename' },
        headers: { 'Content-Type': source.mimeType || 'application/octet-stream' },
        data: content,
        maxBodyLength: Infinity,
      });
      return this.item(created);
    }
    const session = await this.call<{ uploadUrl?: string }>(token, {
      method: 'post',
      url: `${target}/createUploadSession`,
      data: { item: { '@microsoft.graph.conflictBehavior': 'rename' } },
      retry: true,
    });
    const uploadUrl = session.uploadUrl ?? '';
    if (!uploadUrl.startsWith('https://')) throw new CloudError('unavailable', 'OneDrive didn’t start the upload. Try again.');
    const handle = await fs.open(source.path, 'r');
    try {
      for (let start = 0; start < source.size; start += CHUNK_BYTES) {
        const length = Math.min(CHUNK_BYTES, source.size - start);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, start);
        // The session address carries its own authorization: our token must not be sent to it.
        const response = await cloudRequest<GraphItem>(this.http, LABEL, {
          method: 'put',
          url: uploadUrl,
          headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${start + length - 1}/${source.size}` },
          data: chunk,
          maxBodyLength: Infinity,
          timeout: 120_000,
        });
        if (response.status === 200 || response.status === 201) return this.item(response.data);
      }
    } catch (err) {
      // Leave nothing half-uploaded behind.
      await cloudRequest(this.http, LABEL, { method: 'delete', url: uploadUrl }).catch(() => undefined);
      throw err;
    } finally {
      await handle.close();
    }
    throw new CloudError('unavailable', 'OneDrive didn’t confirm the upload. Check the folder and try again.');
  }
}
