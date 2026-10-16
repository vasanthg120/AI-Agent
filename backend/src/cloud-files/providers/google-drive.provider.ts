import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { cloudRequest, CloudError } from '../cloud-http';
import {
  CloudAccount,
  CloudDownload,
  CloudFileType,
  CloudItem,
  CloudPreview,
  CloudProvider,
  CloudTokens,
  inlineType,
  ListOptions,
  ListResult,
  ROOT_REF,
  SearchOptions,
  SHARED_REF,
  UploadSource,
} from '../cloud-files.types';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const LABEL = 'Google Drive';
// Full Drive: browse, search and manage every folder from inside HaiVE (the organization's choice, 2026-10-15).
// Google calls it a restricted scope — see the setup notes in cloud-files.module.ts.
const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,parents,driveId,shared,trashed,owners(displayName),capabilities(canEdit,canTrash,canRename,canAddChildren)';
const PAGE_SIZE = 100;
// Resumable uploads go up in pieces of this size (a multiple of 256 KiB, as Google requires).
const CHUNK_BYTES = 8 * 1024 * 1024;
const ANCESTOR_DEPTH = 25;
// Google's own documents have no file to download: they are exported, as Office files or as PDF.
const EXPORTS: Record<string, { mime: string; extension: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: 'pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', extension: 'pdf' },
};
const TYPE_QUERY: Record<CloudFileType, string> = {
  folder: `mimeType = '${FOLDER}'`,
  document: `(mimeType = 'application/vnd.google-apps.document' or mimeType contains 'wordprocessingml' or mimeType = 'application/msword' or mimeType = 'text/plain')`,
  spreadsheet: `(mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType contains 'spreadsheetml' or mimeType = 'application/vnd.ms-excel' or mimeType = 'text/csv')`,
  presentation: `(mimeType = 'application/vnd.google-apps.presentation' or mimeType contains 'presentationml' or mimeType = 'application/vnd.ms-powerpoint')`,
  pdf: `mimeType = 'application/pdf'`,
  image: `mimeType contains 'image/'`,
  video: `mimeType contains 'video/'`,
  audio: `mimeType contains 'audio/'`,
  archive: `(mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed' or mimeType = 'application/x-7z-compressed' or mimeType = 'application/x-rar-compressed')`,
};
const ORDER: Record<string, string> = { name: 'name', modified: 'modifiedTime', size: 'quotaBytesUsed' };

/** A value inside a Drive query string. */
const quoted = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const isId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  parents?: string[];
  driveId?: string;
  shared?: boolean;
  trashed?: boolean;
  owners?: { displayName?: string }[];
  capabilities?: { canEdit?: boolean; canTrash?: boolean; canRename?: boolean; canAddChildren?: boolean };
}

@Injectable()
export class GoogleDriveProvider implements CloudProvider {
  readonly id = 'google_drive' as const;

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private setting(key: 'clientId' | 'clientSecret' | 'redirectUri'): string {
    return this.config.get<string>(`cloudFiles.google.${key}`) ?? '';
  }

  configured(): boolean {
    return !!this.setting('clientId') && !!this.setting('clientSecret');
  }

  permissions(scope: string): string[] {
    const granted = scope.split(/\s+/);
    return [
      ...(granted.includes('https://www.googleapis.com/auth/drive') ? ['See, edit, create and delete your Google Drive files'] : []),
      ...(granted.some((s) => s === 'email' || s.endsWith('userinfo.email')) ? ['Your email address'] : []),
    ];
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.setting('clientId'),
      redirect_uri: this.setting('redirectUri'),
      response_type: 'code',
      scope: SCOPES,
      // offline + consent: Google returns a refresh token only on a consent screen.
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  private async token(body: Record<string, string>): Promise<CloudTokens> {
    const { data } = await cloudRequest<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(this.http, LABEL, {
      method: 'post',
      url: 'https://oauth2.googleapis.com/token',
      data: new URLSearchParams({ client_id: this.setting('clientId'), client_secret: this.setting('clientSecret'), ...body }).toString(),
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
    const { data } = await cloudRequest<{ sub: string; email: string; name?: string }>(this.http, LABEL, {
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { accountId: data.sub, email: data.email, name: data.name };
  }

  async revoke(tokens: { accessToken?: string; refreshToken?: string }): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    await cloudRequest(this.http, LABEL, {
      method: 'post',
      url: 'https://oauth2.googleapis.com/revoke',
      data: new URLSearchParams({ token }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      retry: true,
    });
  }

  private async call<T = any>(token: string, config: Parameters<typeof cloudRequest>[2]): Promise<T> {
    const { data } = await cloudRequest<T>(this.http, LABEL, { ...config, headers: { Authorization: `Bearer ${token}`, ...(config.headers ?? {}) } });
    return data;
  }

  private item(file: DriveFile, root = false): CloudItem {
    const caps = file.capabilities ?? {};
    return {
      id: file.id,
      name: file.name,
      kind: file.mimeType === FOLDER ? 'folder' : 'file',
      mimeType: file.mimeType,
      size: file.size !== undefined ? Number(file.size) : undefined,
      modifiedAt: file.modifiedTime,
      createdAt: file.createdTime,
      webUrl: file.webViewLink,
      parentId: file.parents?.[0],
      owner: file.owners?.[0]?.displayName,
      canEdit: caps.canEdit ?? caps.canAddChildren,
      canDelete: caps.canTrash,
      shared: file.shared,
      ...(root ? { root: true } : {}),
    };
  }

  private folderRef(folderId: string): string {
    if (folderId === ROOT_REF) return 'root';
    if (!isId(folderId)) throw new CloudError('not_found', 'That folder isn’t in Google Drive.');
    return folderId;
  }

  async roots(token: string): Promise<CloudItem[]> {
    const drives = await this.call<{ drives?: { id: string; name: string }[] }>(token, { url: `${API}/drives`, params: { pageSize: 50 } }).catch(() => ({
      drives: [],
    }));
    return [
      { id: ROOT_REF, name: 'My Drive', kind: 'folder', root: true, canEdit: true },
      { id: SHARED_REF, name: 'Shared with me', kind: 'folder', root: true, canEdit: false },
      ...(drives.drives ?? []).map((d): CloudItem => ({ id: d.id, name: d.name, kind: 'folder', root: true })),
    ];
  }

  private async files(token: string, q: string, options: { cursor?: string; orderBy?: string; pageSize?: number }): Promise<ListResult> {
    const data = await this.call<{ files: DriveFile[]; nextPageToken?: string }>(token, {
      url: `${API}/files`,
      params: {
        q,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: options.pageSize ?? PAGE_SIZE,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
        ...(options.orderBy ? { orderBy: options.orderBy } : {}),
        ...(options.cursor ? { pageToken: options.cursor } : {}),
      },
    });
    return { items: (data.files ?? []).map((f) => this.item(f)), cursor: data.nextPageToken };
  }

  async list(token: string, folderId: string, options: ListOptions): Promise<ListResult> {
    const sort = options.sort ?? 'name';
    const direction = options.direction ?? (sort === 'name' ? 'asc' : 'desc');
    const where =
      folderId === SHARED_REF ? 'sharedWithMe = true' : `${quoted(this.folderRef(folderId))} in parents`;
    const filters = [where, 'trashed = false', ...(options.foldersOnly ? [TYPE_QUERY.folder] : options.type ? [TYPE_QUERY[options.type]] : [])];
    return this.files(token, filters.join(' and '), {
      cursor: options.cursor,
      // "Shared with me" can't be ordered by folder first; everything else can.
      orderBy: folderId === SHARED_REF ? `${ORDER[sort]}${direction === 'desc' ? ' desc' : ''}` : `folder,${ORDER[sort]}${direction === 'desc' ? ' desc' : ''}`,
    });
  }

  async search(token: string, options: SearchOptions): Promise<ListResult> {
    const words = options.query.trim();
    const filters = [
      'trashed = false',
      ...(words ? [`(name contains ${quoted(words)} or fullText contains ${quoted(words)})`] : []),
      ...(options.type ? [TYPE_QUERY[options.type]] : []),
      ...(options.modifiedAfter ? [`modifiedTime > ${quoted(options.modifiedAfter.toISOString())}`] : []),
      ...(options.folderId && options.folderId !== SHARED_REF ? [`${quoted(this.folderRef(options.folderId))} in parents`] : []),
      ...(options.folderId === SHARED_REF ? ['sharedWithMe = true'] : []),
    ];
    // A full-text search can't be ordered; the provider returns the best matches first.
    return this.files(token, filters.join(' and '), { cursor: options.cursor });
  }

  private async file(token: string, id: string): Promise<DriveFile> {
    return this.call<DriveFile>(token, { url: `${API}/files/${encodeURIComponent(this.folderRef(id))}`, params: { fields: FIELDS, supportsAllDrives: true } });
  }

  async get(token: string, id: string): Promise<CloudItem> {
    if (id === SHARED_REF) return { id: SHARED_REF, name: 'Shared with me', kind: 'folder', root: true };
    const file = await this.file(token, id);
    if (file.trashed) throw new CloudError('not_found', 'That file is in the Google Drive trash.');
    // The top of a drive: My Drive, or a shared drive.
    const isRoot = !file.parents?.length && file.mimeType === FOLDER;
    return { ...this.item(file, isRoot), ...(isRoot && !file.driveId ? { name: 'My Drive' } : {}) };
  }

  async ancestors(token: string, id: string): Promise<CloudItem[]> {
    const chain: CloudItem[] = [];
    let current = await this.file(token, id);
    for (let depth = 0; depth < ANCESTOR_DEPTH && current.parents?.length; depth++) {
      current = await this.file(token, current.parents[0]);
      const isRoot = !current.parents?.length;
      chain.push({ ...this.item(current, isRoot), ...(isRoot && !current.driveId ? { name: 'My Drive' } : {}) });
    }
    return chain;
  }

  async download(token: string, id: string, as: 'original' | 'pdf' = 'original'): Promise<CloudDownload> {
    const file = await this.file(token, id);
    if (file.mimeType === FOLDER) throw new CloudError('bad_request', 'A folder can’t be downloaded as one file.');
    const native = file.mimeType.startsWith('application/vnd.google-apps.');
    const exported = native ? (as === 'pdf' ? { mime: 'application/pdf', extension: 'pdf' } : EXPORTS[file.mimeType]) : undefined;
    if (native && !exported) throw new CloudError('bad_request', 'This kind of Google file can only be opened in Google Drive.');
    const { data } = await cloudRequest<Readable>(this.http, LABEL, {
      url: exported ? `${API}/files/${encodeURIComponent(file.id)}/export` : `${API}/files/${encodeURIComponent(file.id)}`,
      params: exported ? { mimeType: exported.mime } : { alt: 'media', supportsAllDrives: true, acknowledgeAbuse: false },
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'stream',
      timeout: 120_000,
    });
    return {
      stream: data,
      name: exported && !file.name.toLowerCase().endsWith(`.${exported.extension}`) ? `${file.name}.${exported.extension}` : file.name,
      mimeType: exported?.mime ?? file.mimeType,
      size: exported ? undefined : file.size !== undefined ? Number(file.size) : undefined,
    };
  }

  async preview(_token: string, item: CloudItem): Promise<CloudPreview> {
    if (item.kind === 'folder') return { kind: 'none' };
    if (inlineType(item.mimeType)) return { kind: 'inline' };
    if (['document', 'spreadsheet', 'presentation', 'drawing'].some((t) => item.mimeType === `application/vnd.google-apps.${t}`)) return { kind: 'pdf' };
    return item.webUrl ? { kind: 'link', url: item.webUrl } : { kind: 'none' };
  }

  private async named(token: string, parentId: string, name: string, folder: boolean): Promise<DriveFile[]> {
    const q = [`${quoted(this.folderRef(parentId))} in parents`, `name = ${quoted(name)}`, 'trashed = false', folder ? TYPE_QUERY.folder : `mimeType != '${FOLDER}'`];
    const data = await this.call<{ files: DriveFile[] }>(token, {
      url: `${API}/files`,
      params: { q: q.join(' and '), fields: `files(${FIELDS})`, pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives' },
    });
    return data.files ?? [];
  }

  async createFolder(token: string, parentId: string, name: string): Promise<CloudItem> {
    const [existing] = await this.named(token, parentId, name, true);
    if (existing) return this.item(existing);
    const created = await this.call<DriveFile>(token, {
      method: 'post',
      url: `${API}/files`,
      params: { fields: FIELDS, supportsAllDrives: true },
      data: { name, mimeType: FOLDER, parents: [this.folderRef(parentId)] },
    });
    return this.item(created);
  }

  async update(token: string, id: string, change: { name?: string; parentId?: string }): Promise<CloudItem> {
    const file = await this.file(token, id);
    const moving = change.parentId !== undefined && !file.parents?.includes(this.folderRef(change.parentId));
    const updated = await this.call<DriveFile>(token, {
      method: 'patch',
      url: `${API}/files/${encodeURIComponent(file.id)}`,
      params: {
        fields: FIELDS,
        supportsAllDrives: true,
        ...(moving ? { addParents: this.folderRef(change.parentId!), removeParents: (file.parents ?? []).join(',') } : {}),
      },
      data: change.name ? { name: change.name } : {},
    });
    return this.item(updated);
  }

  async remove(token: string, id: string): Promise<void> {
    await this.call(token, {
      method: 'patch',
      url: `${API}/files/${encodeURIComponent(this.folderRef(id))}`,
      params: { supportsAllDrives: true, fields: 'id' },
      data: { trashed: true },
    });
  }

  /** "Report.pdf" → "Report (2).pdf" while the name is taken in the folder. Google itself would allow two files with one name. */
  private async freeName(token: string, parentId: string, name: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; n < 50; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${extension}`;
      if ((await this.named(token, parentId, candidate, false)).length === 0) return candidate;
    }
    return `${stem} (${Date.now()})${extension}`;
  }

  async upload(token: string, parentId: string, name: string, source: UploadSource): Promise<CloudItem> {
    const finalName = await this.freeName(token, parentId, name);
    // A resumable session for every size: one code path, and a large file survives a dropped piece.
    const session = await cloudRequest(this.http, LABEL, {
      method: 'post',
      url: `${UPLOAD_API}/files`,
      params: { uploadType: 'resumable', supportsAllDrives: true, fields: FIELDS },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': source.mimeType,
        'X-Upload-Content-Length': String(source.size),
      },
      data: { name: finalName, parents: [this.folderRef(parentId)] },
      retry: true,
    });
    const location = String(session.headers.location ?? '');
    if (!location.startsWith('https://www.googleapis.com/')) throw new CloudError('unavailable', 'Google Drive didn’t start the upload. Try again.');

    if (source.size === 0) {
      const { data } = await cloudRequest<DriveFile>(this.http, LABEL, { method: 'put', url: location, headers: { 'Content-Range': 'bytes */0' }, data: Buffer.alloc(0) });
      return this.item(data);
    }
    const handle = await fs.open(source.path, 'r');
    try {
      for (let start = 0; start < source.size; start += CHUNK_BYTES) {
        const length = Math.min(CHUNK_BYTES, source.size - start);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, start);
        const response = await cloudRequest<DriveFile>(this.http, LABEL, {
          method: 'put',
          url: location,
          headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${start + length - 1}/${source.size}` },
          data: chunk,
          maxBodyLength: Infinity,
          // 308: Google has the piece and wants the next one.
          validateStatus: (status) => status === 200 || status === 201 || status === 308,
          timeout: 120_000,
        });
        if (response.status !== 308) return this.item(response.data);
      }
    } finally {
      await handle.close();
    }
    throw new CloudError('unavailable', 'Google Drive didn’t confirm the upload. Check the folder and try again.');
  }
}
