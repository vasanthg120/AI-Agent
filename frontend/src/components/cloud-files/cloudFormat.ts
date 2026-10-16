import {
  FiArchive,
  FiFile,
  FiFileText,
  FiFilm,
  FiFolder,
  FiGrid,
  FiImage,
  FiMonitor,
  FiMusic,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import type { CloudFileType, CloudItem } from '@/services/cloudFilesService';

// How a cloud file is shown: its size, date, kind and icon — the same words in the
// file manager, the picker and the customer's documents.

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatModified(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
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

// Google's own documents have no file of their own: HaiVE downloads them as Office files.
const GOOGLE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'docx',
  'application/vnd.google-apps.spreadsheet': 'xlsx',
  'application/vnd.google-apps.presentation': 'pptx',
  'application/vnd.google-apps.drawing': 'pdf',
};

/** The name a file is saved under: a Google document gets the extension it is downloaded as. */
export function downloadName(item: Pick<CloudItem, 'name' | 'mimeType'>): string {
  const extension = item.mimeType ? GOOGLE_EXPORT[item.mimeType] : undefined;
  return extension && !item.name.toLowerCase().endsWith(`.${extension}`) ? `${item.name}.${extension}` : item.name;
}

export function extensionOf(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

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
  const extension = extensionOf(item.name);
  return (Object.keys(EXTENSIONS) as (keyof typeof EXTENSIONS)[]).find((type) => EXTENSIONS[type].includes(extension));
}

const ICONS: Record<CloudFileType, IconType> = {
  folder: FiFolder,
  document: FiFileText,
  spreadsheet: FiGrid,
  presentation: FiMonitor,
  pdf: FiFileText,
  image: FiImage,
  video: FiFilm,
  audio: FiMusic,
  archive: FiArchive,
};

export function iconOf(item: Pick<CloudItem, 'kind' | 'name' | 'mimeType'>): IconType {
  const type = fileTypeOf(item);
  return type ? ICONS[type] : FiFile;
}

export const TYPE_LABEL: Record<CloudFileType, string> = {
  folder: 'Folders',
  document: 'Documents',
  spreadsheet: 'Spreadsheets',
  presentation: 'Presentations',
  pdf: 'PDFs',
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  archive: 'Archives',
};

/** Whether a picked file fits what the page that asked for it takes (".pdf,.png" — empty takes anything). */
export function accepts(accept: string | undefined, item: Pick<CloudItem, 'name' | 'mimeType'>): boolean {
  if (!accept) return true;
  const allowed = accept
    .split(',')
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(extensionOf(downloadName(item)));
}
