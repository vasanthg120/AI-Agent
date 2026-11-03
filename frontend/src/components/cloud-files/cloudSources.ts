import {
  cloudFilesService,
  type CloudFileType,
  type CloudFolderListing,
  type CloudItem,
  type CloudPreview,
  type CloudSort,
} from '@/services/cloudFilesService';
import { customerCloudService } from '@/services/customerCloudService';

/**
 * Where a browser, a preview or an upload reads its files from: one connected account (the Files
 * page, the pickers), or one customer's folder or attached file (the customer's documents, opened
 * through the customer). The same components show them all.
 */
export interface CloudSource {
  /** Part of every cache key, so two sources never share cached listings. */
  key: string;
  roots?: () => Promise<CloudItem[]>;
  list: (folderId: string, options: { cursor?: string; sort?: CloudSort; direction?: 'asc' | 'desc'; type?: CloudFileType; foldersOnly?: boolean }) => Promise<CloudFolderListing>;
  search: (query: { q: string; type?: CloudFileType; modifiedAfter?: string; folderId?: string; cursor?: string }) => Promise<{ items: CloudItem[]; cursor?: string }>;
  /** The item and the folders above it (absent: search results open beside where browsing started). */
  item?: (itemId: string, withPath: boolean) => Promise<{ item: CloudItem; path?: CloudItem[] }>;
  preview: (itemId: string) => Promise<CloudPreview>;
  content: (itemId: string, options?: { inline?: boolean; onProgress?: (percent: number) => void; signal?: AbortSignal }) => Promise<Blob>;
  createFolder?: (parentId: string, name: string) => Promise<CloudItem>;
  update?: (itemId: string, change: { name?: string; parentId?: string }) => Promise<CloudItem>;
  remove?: (itemId: string) => Promise<void>;
  upload?: (parentId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal) => Promise<CloudItem>;
}

/** Everything of one connected account the person may open (the backend decides what). */
export function connectionSource(connectionId: string): CloudSource {
  return {
    key: `connection:${connectionId}`,
    roots: () => cloudFilesService.roots(connectionId),
    list: (folderId, options) => cloudFilesService.list(connectionId, folderId, options),
    search: (query) => cloudFilesService.search(connectionId, query),
    item: (itemId, withPath) => cloudFilesService.item(connectionId, itemId, withPath),
    preview: (itemId) => cloudFilesService.preview(connectionId, itemId),
    content: (itemId, options) => cloudFilesService.content(connectionId, itemId, options),
    createFolder: (parentId, name) => cloudFilesService.createFolder(connectionId, parentId, name),
    update: (itemId, change) => cloudFilesService.update(connectionId, itemId, change),
    remove: (itemId) => cloudFilesService.remove(connectionId, itemId),
    upload: (parentId, file, onProgress, signal) => cloudFilesService.upload(connectionId, parentId, file, onProgress, signal),
  };
}

/** One folder linked to a customer, and what is inside it — nothing above it. Renames, moves and deletes happen on the Files page. */
export function customerFolderSource(customerId: string, mappingId: string): CloudSource {
  return {
    key: `customer:${customerId}:${mappingId}`,
    list: (folderId, options) => customerCloudService.list(customerId, mappingId, folderId, options),
    search: (query) => customerCloudService.search(customerId, mappingId, query.q, query.type),
    preview: (itemId) => customerCloudService.folderPreview(customerId, mappingId, itemId),
    content: (itemId, options) => customerCloudService.folderContent(customerId, mappingId, itemId, options),
    createFolder: (parentId, name) => customerCloudService.createSubfolder(customerId, mappingId, parentId, name),
    upload: (parentId, file, onProgress, signal) => customerCloudService.upload(customerId, mappingId, parentId, file, onProgress, signal),
  };
}

/** A single cloud file attached to a customer (to preview and download it). */
export function customerLinkSource(customerId: string, linkId: string): CloudSource {
  const none = () => Promise.reject(new Error('Not available for an attached file.'));
  return {
    key: `customer-link:${customerId}:${linkId}`,
    list: none,
    search: none,
    preview: () => customerCloudService.linkPreview(customerId, linkId),
    content: (_itemId, options) => customerCloudService.linkContent(customerId, linkId, options),
  };
}
