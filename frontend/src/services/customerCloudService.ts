import { axiosClient } from '@/api/axiosClient';
import { readBlobErrorBody } from '@/utils/errors';
import type { CloudFileType, CloudFolderListing, CloudItem, CloudPreview, CloudProviderId, CloudSort } from './cloudFilesService';

// A customer's Google Drive / OneDrive documents (backend:
// customer-intelligence/customer-cloud.*): folders linked to or made for the
// customer, and single cloud files attached to them. Opened through the
// customer, so whoever may open the customer may open its company folder —
// and someone's own folder opens with the viewer's own account.

export type DocumentCategory = 'quotation' | 'invoice' | 'contract' | 'purchase_order' | 'order' | 'email_attachment' | 'other';
export const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  quotation: 'Quotation',
  invoice: 'Invoice',
  contract: 'Contract',
  purchase_order: 'Purchase order',
  order: 'Order',
  email_attachment: 'Email attachment',
  other: 'Other',
};

/** open · own_account: opens with your own account if it was shared with you · reconnect · disconnected. */
export type CloudReach = 'open' | 'own_account' | 'reconnect' | 'disconnected';

export interface CustomerCloudFolder {
  id: string;
  provider: CloudProviderId;
  ownership: 'personal' | 'company';
  folderId: string;
  name: string;
  webUrl?: string;
  ownerName?: string;
  accountEmail?: string;
  subfolders: { key: string; label: string; folderId: string }[];
  linkedBy: string;
  at: string;
  reach: CloudReach;
  canUnlink: boolean;
  /** When the last sync listed what is inside it, and how much it found. */
  indexedAt?: string;
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
  modifiedAt?: string;
  webUrl?: string;
  location?: string;
  category: DocumentCategory;
  linkedTo?: { kind: 'quotation'; id: string; label: string };
  attachedBy: string;
  at: string;
  status: 'available' | 'moved' | 'deleted' | 'no_access';
  ownerName?: string;
  reach: CloudReach;
  canRemove: boolean;
}

export interface CustomerCloudOverview {
  folders: CustomerCloudFolder[];
  links: CustomerCloudLink[];
  categories: DocumentCategory[];
  subfolders: { key: string; label: string }[];
}

export interface HaiveCustomerFile {
  id: string;
  customerId: string;
  customerName: string;
  name: string;
  size: number;
  type: string;
  uploadedBy: string;
  at: string;
  copiedFrom?: CloudProviderId;
}

const root = (customerId: string) => `/customers/${encodeURIComponent(customerId)}/cloud`;
const folder = (customerId: string, mappingId: string) => `${root(customerId)}/folders/${encodeURIComponent(mappingId)}`;
const link = (customerId: string, linkId: string) => `${root(customerId)}/links/${encodeURIComponent(linkId)}`;

async function blob(url: string, options: { inline?: boolean; onProgress?: (percent: number) => void; signal?: AbortSignal }) {
  try {
    const { data } = await axiosClient.get<Blob>(url, {
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
}

export const customerCloudService = {
  async overview(customerId: string): Promise<CustomerCloudOverview> {
    const { data } = await axiosClient.get<CustomerCloudOverview>(root(customerId));
    return data;
  },

  async linkFolder(customerId: string, connectionId: string, folderId: string): Promise<CustomerCloudFolder> {
    const { data } = await axiosClient.post<CustomerCloudFolder>(`${root(customerId)}/folders`, { connectionId, folderId });
    return data;
  },

  async createFolder(customerId: string, connectionId: string, parentId: string, name: string, subfolders: boolean): Promise<CustomerCloudFolder> {
    const { data } = await axiosClient.post<CustomerCloudFolder>(`${root(customerId)}/folders`, { connectionId, parentId, name, subfolders });
    return data;
  },

  async unlinkFolder(customerId: string, mappingId: string): Promise<void> {
    await axiosClient.delete(folder(customerId, mappingId));
  },

  async list(
    customerId: string,
    mappingId: string,
    folderId: string,
    options: { cursor?: string; sort?: CloudSort; direction?: 'asc' | 'desc'; type?: CloudFileType },
  ): Promise<CloudFolderListing> {
    const { data } = await axiosClient.get<CloudFolderListing>(`${folder(customerId, mappingId)}/items`, { params: { folderId, ...options } });
    return data;
  },

  async search(customerId: string, mappingId: string, q: string, type?: CloudFileType): Promise<{ items: CloudItem[]; cursor?: string }> {
    const { data } = await axiosClient.get<{ items: CloudItem[]; cursor?: string }>(`${folder(customerId, mappingId)}/search`, { params: { q, type } });
    return data;
  },

  async folderPreview(customerId: string, mappingId: string, itemId: string): Promise<CloudPreview> {
    const { data } = await axiosClient.get<CloudPreview>(`${folder(customerId, mappingId)}/items/${encodeURIComponent(itemId)}/preview`);
    return data;
  },

  folderContent(customerId: string, mappingId: string, itemId: string, options: { inline?: boolean; onProgress?: (percent: number) => void; signal?: AbortSignal } = {}) {
    return blob(`${folder(customerId, mappingId)}/items/${encodeURIComponent(itemId)}/content`, options);
  },

  async createSubfolder(customerId: string, mappingId: string, parentId: string, name: string): Promise<CloudItem> {
    const { data } = await axiosClient.post<CloudItem>(`${folder(customerId, mappingId)}/folders`, { parentId, name });
    return data;
  },

  async upload(customerId: string, mappingId: string, parentId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<CloudItem> {
    const form = new FormData();
    form.append('parentId', parentId);
    form.append('file', file);
    const { data } = await axiosClient.post<CloudItem>(`${folder(customerId, mappingId)}/upload`, form, {
      signal,
      timeout: 0,
      onUploadProgress: (event) => {
        if (onProgress && event.total) onProgress(Math.round((event.loaded / event.total) * 100));
      },
    });
    return data;
  },

  async attach(customerId: string, connectionId: string, fileIds: string[], category?: DocumentCategory, quotationId?: string): Promise<CustomerCloudLink[]> {
    const { data } = await axiosClient.post<CustomerCloudLink[]>(`${root(customerId)}/links`, { connectionId, fileIds, category, quotationId });
    return data;
  },

  async updateLink(customerId: string, linkId: string, change: { category?: DocumentCategory; quotationId?: string | null }): Promise<CustomerCloudLink> {
    const { data } = await axiosClient.patch<CustomerCloudLink>(link(customerId, linkId), change);
    return data;
  },

  async removeLink(customerId: string, linkId: string): Promise<void> {
    await axiosClient.delete(link(customerId, linkId));
  },

  async linkPreview(customerId: string, linkId: string): Promise<CloudPreview> {
    const { data } = await axiosClient.get<CloudPreview>(`${link(customerId, linkId)}/preview`);
    return data;
  },

  linkContent(customerId: string, linkId: string, options: { inline?: boolean; onProgress?: (percent: number) => void; signal?: AbortSignal } = {}) {
    return blob(`${link(customerId, linkId)}/content`, options);
  },

  async copyIntoHaive(customerId: string, linkId: string): Promise<{ id: string; name: string }> {
    const { data } = await axiosClient.post<{ id: string; name: string }>(`${link(customerId, linkId)}/copy`);
    return data;
  },

  async haiveFiles(): Promise<HaiveCustomerFile[]> {
    const { data } = await axiosClient.get<HaiveCustomerFile[]>('/customer-files');
    return data;
  },
};
