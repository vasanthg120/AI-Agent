import { BadRequestException } from '@nestjs/common';

// What HaiVE takes in as a file someone attaches or uploads: a document, an image,
// an archive — never anything that runs. Shared by customer files and the cloud
// file uploads (Google Drive / OneDrive), so both refuse the same things.
export const REFUSED_EXTENSIONS = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jar', 'sh', 'app', 'dll', 'html', 'htm', 'hta', 'lnk']);

export const MAX_FILENAME = 160;

/** A name as a browser sent it, reduced to its last path part without anything a header or a folder could choke on ('' when nothing is left). */
export function cleanFileName(raw: string | undefined, max = MAX_FILENAME): string {
  return (raw ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .trim()
    .slice(-max);
}

/** Refuses a name with nothing usable in it, or a kind of file that runs. */
export function assertAcceptableFile(name: string): void {
  if (!name) throw new BadRequestException('That file has no usable name.');
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (REFUSED_EXTENSIONS.has(extension))
    throw new BadRequestException(`.${extension} files can’t be attached. Attach a document, an image or an archive instead.`);
}
