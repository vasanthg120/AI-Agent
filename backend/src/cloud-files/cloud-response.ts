import { Response } from 'express';
import { CloudDownload } from './cloud-files.types';

/**
 * Streams a cloud file to the browser. A download by default; `inline` (only ever an image, a PDF or
 * plain text — the services refuse anything else) is shown under a sandbox that runs nothing.
 */
export function sendCloudFile(res: Response, file: CloudDownload, inline: boolean) {
  res.set({
    'Content-Type': inline ? file.mimeType : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
    'Cache-Control': 'private, no-store',
    ...(file.size !== undefined ? { 'Content-Length': String(file.size) } : {}),
  });
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
}
