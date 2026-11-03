import { axiosClient } from '@/api/axiosClient';
import { readBlobErrorBody } from '@/utils/errors';

// Google Drive and OneDrive, through HaiVE's backend (backend/src/cloud-files).
// The page never sees a provider token: it names a connected account by id and
// the backend decides what that person may open.

export type CloudProviderId = 'google_drive' | 'onedrive';
export type CloudOwnership = 'personal' | 'company';
export type CloudSort = 'name' | 'modified' | 'size';
export type CloudFileType = 'folder' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'video' | 'audio' | 'archive';

export const CLOUD_PROVIDER_LABEL: Record<CloudProviderId, string> = { google_drive: 'Google Drive', onedrive: 'OneDrive' };
export const CLOUD_PROVIDER_LOGO: Record<CloudProviderId, string> = { google_drive: '/integrations/google-drive.svg', onedrive: '/integrations/onedrive.svg' };
/** The starting points every account has besides its own folders. */
export const CLOUD_ROOT = 'root';
export const CLOUD_SHARED = 'shared';

export interface CloudConnection {
  id: string;
  provider: CloudProviderId;
  ownership: CloudOwnership;
  accountEmail: string;
  accountName?: string;
  status: 'connected' | 'needs_reauth';
  connectedAt?: string;
  connectedBy?: string;
  permissions: string[];
  lastSyncAt?: string;
  lastSyncStatus?: 'ok' | 'error';
  lastSyncError?: string;
  canManage: boolean;
  /** Company account: how many folders the person can open (null: all of it). */
  sharedFolders?: number | null;
}

export interface CloudProviderOverview {
  id: CloudProviderId;
  label: string;
  configured: boolean;
  mine: CloudConnection[];
  company: CloudConnection | null;
  canConnectCompany: boolean;
}

export interface CloudOverview {
  providers: CloudProviderOverview[];
  grantableRoles: string[];
  maxUploadBytes: number;
}

export interface CloudItem {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
  createdAt?: string;
  webUrl?: string;
  parentId?: string;
  owner?: string;
  canEdit?: boolean;
  canDelete?: boolean;
  shared?: boolean;
  root?: boolean;
}

export interface CloudFolderListing {
  folder: CloudItem;
  items: CloudItem[];
  cursor?: string;
  canEdit: boolean;
}

export interface CloudPreview {
  kind: 'inline' | 'pdf' | 'embed' | 'link' | 'none';
  url?: string;
  item: CloudItem;
}

export interface CloudFolderGrant {
  folderId: string;
  name: string;
  path: string;
  roles: string[];
  access: 'view' | 'edit';
}

/** An error from a provider says what kind it is, so the page can offer Reconnect or Retry. */
export function cloudErrorKind(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { kind?: string } } })?.response?.data;
  return typeof data?.kind === 'string' ? data.kind : undefined;
}

/** Which account a connection is, in one line ("Company · sales@acme.com"). */
export function connectionLabel(connection: CloudConnection): string {
  return `${connection.ownership === 'company' ? 'Company' : 'Mine'} · ${connection.accountEmail || CLOUD_PROVIDER_LABEL[connection.provider]}`;
}

const base = (connectionId: string) => `/cloud-files/connections/${encodeURIComponent(connectionId)}`;
const item = (connectionId: string, itemId: string) => `${base(connectionId)}/items/${encodeURIComponent(itemId)}`;

export const cloudFilesService = {
  async overview(): Promise<CloudOverview> {
    const { data } = await axiosClient.get<CloudOverview>('/cloud-files/providers');
    return data;
  },

  async connectUrl(provider: CloudProviderId, ownership: CloudOwnership): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>(`/cloud-files/${provider}/connect-url`, { params: { ownership } });
    return data.url;
  },

  async disconnect(connectionId: string): Promise<void> {
    await axiosClient.delete(base(connectionId));
  },

  /** Re-checks the customer documents kept from this account (attached files, customer folders). */
  async sync(connectionId: string): Promise<{ linksChecked: number; linksChanged: number; linksGone: number; foldersIndexed: number; filesIndexed: number; partial: boolean }> {
    const { data } = await axiosClient.post(`${base(connectionId)}/sync`, {}, { timeout: 0 });
    return data;
  },

  async roots(connectionId: string): Promise<CloudItem[]> {
    const { data } = await axiosClient.get<CloudItem[]>(`${base(connectionId)}/roots`);
    return data;
  },

  async list(
    connectionId: string,
    folderId: string,
    options: { cursor?: string; sort?: CloudSort; direction?: 'asc' | 'desc'; type?: CloudFileType; foldersOnly?: boolean } = {},
  ): Promise<CloudFolderListing> {
    const { data } = await axiosClient.get<CloudFolderListing>(`${base(connectionId)}/items`, {
      params: { folderId, ...options, foldersOnly: options.foldersOnly ? '1' : undefined },
    });
    return data;
  },

  async search(
    connectionId: string,
    query: { q: string; type?: CloudFileType; modifiedAfter?: string; folderId?: string; cursor?: string },
  ): Promise<{ items: CloudItem[]; cursor?: string }> {
    const { data } = await axiosClient.get<{ items: CloudItem[]; cursor?: string }>(`${base(connectionId)}/search`, { params: query });
    return data;
  },

  async item(connectionId: string, itemId: string, withPath = false): Promise<{ item: CloudItem; path?: CloudItem[] }> {
    const { data } = await axiosClient.get<{ item: CloudItem; path?: CloudItem[] }>(item(connectionId, itemId), { params: withPath ? { path: '1' } : {} });
    return data;
  },

  async preview(connectionId: string, itemId: string): Promise<CloudPreview> {
    const { data } = await axiosClient.get<CloudPreview>(`${item(connectionId, itemId)}/preview`);
    return data;
  },

  /** The file's content, fetched through HaiVE (inline: only an image, a PDF or text, to look at). */
  async content(connectionId: string, itemId: string, options: { inline?: boolean; onProgress?: (percent: number) => void; signal?: AbortSignal } = {}): Promise<Blob> {
    try {
      const { data } = await axiosClient.get<Blob>(`${item(connectionId, itemId)}/content`, {
        params: options.inline ? { inline: '1' } : {},
        responseType: 'blob',
        signal: options.signal,
        onDownloadProgress: (event) => {
          if (options.onProgress && event.total) options.onProgress(Math.round((event.loaded / event.total) * 100));
        },
      });
      return data;
    } catch (error) {
      throw await readBlobErrorBody(error);
    }
  },

  async createFolder(connectionId: string, parentId: string, name: string): Promise<CloudItem> {
    const { data } = await axiosClient.post<CloudItem>(`${base(connectionId)}/folders`, { parentId, name });
    return data;
  },

  async update(connectionId: string, itemId: string, change: { name?: string; parentId?: string }): Promise<CloudItem> {
    const { data } = await axiosClient.patch<CloudItem>(item(connectionId, itemId), change);
    return data;
  },

  async remove(connectionId: string, itemId: string): Promise<void> {
    await axiosClient.delete(item(connectionId, itemId));
  },

  async upload(connectionId: string, parentId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<CloudItem> {
    const form = new FormData();
    form.append('parentId', parentId);
    form.append('file', file);
    const { data } = await axiosClient.post<CloudItem>(`${base(connectionId)}/upload`, form, {
      signal,
      // Large files take a while to go on to the provider after they reach HaiVE.
      timeout: 0,
      onUploadProgress: (event) => {
        if (onProgress && event.total) onProgress(Math.round((event.loaded / event.total) * 100));
      },
    });
    return data;
  },

  async grants(connectionId: string): Promise<CloudFolderGrant[]> {
    const { data } = await axiosClient.get<CloudFolderGrant[]>(`${base(connectionId)}/grants`);
    return data;
  },

  async setGrants(connectionId: string, grants: { folderId: string; roles: string[]; access: 'view' | 'edit' }[]): Promise<CloudFolderGrant[]> {
    const { data } = await axiosClient.put<CloudFolderGrant[]>(`${base(connectionId)}/grants`, { grants });
    return data;
  },
};

/** Saves a Blob in the browser's downloads under `name`. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
