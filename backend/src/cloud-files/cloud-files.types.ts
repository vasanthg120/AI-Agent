import { Readable } from 'stream';

// Google Drive and Microsoft OneDrive, behind one shape. Each provider adapter
// (providers/*.provider.ts) knows only its own API; everything that decides who
// may see what lives in cloud-access.service.ts.

export const CLOUD_PROVIDERS = ['google_drive', 'onedrive'] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number];
export const CLOUD_PROVIDER_LABEL: Record<CloudProviderId, string> = { google_drive: 'Google Drive', onedrive: 'OneDrive' };

/** A person's own account (only they browse it), or the organization's company account (shared by grants). */
export type CloudOwnership = 'personal' | 'company';

/** The folder references every provider understands besides its own ids. */
export const ROOT_REF = 'root';
export const SHARED_REF = 'shared';

export interface CloudItem {
  /** The provider's stable id for the item — for OneDrive a reference that also carries its drive. */
  id: string;
  name: string;
  kind: 'folder' | 'file';
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
  createdAt?: string;
  /** Where it opens in Google Drive / OneDrive itself. */
  webUrl?: string;
  parentId?: string;
  owner?: string;
  /** What the connected account may do with it, when the provider says. */
  canEdit?: boolean;
  canDelete?: boolean;
  shared?: boolean;
  /** A starting point (My Drive, Shared with me, a shared drive), not a real folder of its own. */
  root?: boolean;
}

export interface CloudTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
}

export interface CloudAccount {
  accountId: string;
  email: string;
  name?: string;
  tenantId?: string;
  driveId?: string;
}

export type CloudSort = 'name' | 'modified' | 'size';
export type CloudFileType = 'folder' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'video' | 'audio' | 'archive';

export interface ListOptions {
  cursor?: string;
  sort?: CloudSort;
  direction?: 'asc' | 'desc';
  type?: CloudFileType;
  foldersOnly?: boolean;
}

export interface SearchOptions {
  query: string;
  type?: CloudFileType;
  modifiedAfter?: Date;
  /** Search only inside this folder (and, where the provider can, below it). */
  folderId?: string;
  cursor?: string;
}

export interface ListResult {
  items: CloudItem[];
  /** Pass back to get the next page; absent on the last one. */
  cursor?: string;
}

export interface CloudDownload {
  stream: Readable;
  name: string;
  mimeType: string;
  size?: number;
}

/** How a file can be looked at without leaving HaiVE. */
export interface CloudPreview {
  // inline: the file itself (an image, a PDF, plain text) · pdf: a PDF made from it (Google Docs) ·
  // embed: a viewer page the provider hosts · link: only in the provider · none: nothing to show.
  kind: 'inline' | 'pdf' | 'embed' | 'link' | 'none';
  url?: string;
}

/** A file waiting on disk (a multipart upload) to go up to a provider. */
export interface UploadSource {
  path: string;
  size: number;
  mimeType: string;
}

export interface CloudProvider {
  readonly id: CloudProviderId;
  /** Whether the platform has this provider's OAuth app keys. */
  configured(): boolean;
  /** The permissions it asks for, in words. */
  permissions(scope: string): string[];
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<CloudTokens>;
  refresh(refreshToken: string): Promise<CloudTokens>;
  account(accessToken: string): Promise<CloudAccount>;
  revoke(tokens: { accessToken?: string; refreshToken?: string }): Promise<void>;

  roots(token: string): Promise<CloudItem[]>;
  list(token: string, folderId: string, options: ListOptions): Promise<ListResult>;
  search(token: string, options: SearchOptions): Promise<ListResult>;
  get(token: string, id: string): Promise<CloudItem>;
  /** From the item's parent up to the top of its drive. */
  ancestors(token: string, id: string): Promise<CloudItem[]>;
  download(token: string, id: string, as?: 'original' | 'pdf'): Promise<CloudDownload>;
  preview(token: string, item: CloudItem): Promise<CloudPreview>;
  /** The folder of that name in `parentId`, created only when there is none — so a retry never makes a second one. */
  createFolder(token: string, parentId: string, name: string): Promise<CloudItem>;
  update(token: string, id: string, change: { name?: string; parentId?: string }): Promise<CloudItem>;
  /** Into the provider's trash / recycle bin, where it can still be restored. */
  remove(token: string, id: string): Promise<void>;
  /** Never overwrites: a name already taken in the folder gets a number. */
  upload(token: string, parentId: string, name: string, source: UploadSource): Promise<CloudItem>;
}

const EXTENSIONS: Record<Exclude<CloudFileType, 'folder'>, string[]> = {
  document: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'],
  spreadsheet: ['xls', 'xlsx', 'ods', 'csv', 'numbers'],
  presentation: ['ppt', 'pptx', 'odp', 'key'],
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'svg'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
};

/** Which of the file-type filters an item falls under (the same words for both providers). */
export function fileTypeOf(item: Pick<CloudItem, 'kind' | 'name' | 'mimeType'>): CloudFileType | undefined {
  if (item.kind === 'folder') return 'folder';
  const mime = (item.mimeType ?? '').toLowerCase();
  if (mime === 'application/vnd.google-apps.document') return 'document';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'spreadsheet';
  if (mime === 'application/vnd.google-apps.presentation') return 'presentation';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const extension = item.name.includes('.') ? item.name.split('.').pop()!.toLowerCase() : '';
  return (Object.keys(EXTENSIONS) as (keyof typeof EXTENSIONS)[]).find((type) => EXTENSIONS[type].includes(extension));
}

// Shown in the page as they are: an image, a PDF or plain text. Never anything a browser could run (HTML, SVG).
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf', 'text/plain', 'text/csv']);
export const inlineType = (mimeType?: string) => INLINE_TYPES.has((mimeType ?? '').toLowerCase().split(';')[0].trim());

/** Sorts one page the way it was asked for — folders always first — for providers that can't sort on the server. */
export function sortPage(items: CloudItem[], sort: CloudSort = 'name', direction: 'asc' | 'desc' = sort === 'name' ? 'asc' : 'desc'): CloudItem[] {
  const value = (item: CloudItem): string | number =>
    sort === 'modified' ? (item.modifiedAt ? Date.parse(item.modifiedAt) : 0) : sort === 'size' ? (item.size ?? 0) : item.name.toLowerCase();
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    const [x, y] = [value(a), value(b)];
    return x < y ? -sign : x > y ? sign : 0;
  });
}
