import { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Observable, of, throwError } from 'rxjs';
import { cloudRequest, CloudError } from './cloud-http';
import { GoogleDriveProvider } from './providers/google-drive.provider';
import { OneDriveProvider } from './providers/onedrive.provider';

// What HaiVE actually sends to Google Drive and Microsoft Graph, with the HTTP
// layer stubbed: the request shapes, paging, retries and how failures read.

type Reply = Partial<AxiosResponse> | { fail: number; data?: unknown; headers?: Record<string, string> };

function stubHttp(replies: Reply[]) {
  const calls: AxiosRequestConfig[] = [];
  const http = {
    request: jest.fn((config: AxiosRequestConfig): Observable<AxiosResponse> => {
      calls.push(config);
      const reply = replies.shift() ?? { status: 200, data: {} };
      if ('fail' in reply) {
        const error = new AxiosError('failed', String(reply.fail), config as never, undefined, {
          status: reply.fail,
          data: reply.data ?? {},
          headers: reply.headers ?? {},
          statusText: '',
          config: config as never,
        });
        return throwError(() => error);
      }
      return of({ status: 200, headers: {}, statusText: 'OK', config, data: {}, ...reply } as AxiosResponse);
    }),
  };
  return { http, calls };
}

const config = { get: (key: string) => ({ 'cloudFiles.google.clientId': 'g-id', 'cloudFiles.google.clientSecret': 'g-secret', 'cloudFiles.microsoft.clientId': 'm-id', 'cloudFiles.microsoft.clientSecret': 'm-secret', 'cloudFiles.google.redirectUri': 'http://api/cloud-files/google/callback', 'cloudFiles.microsoft.redirectUri': 'http://api/outlook/callback' })[key] };

describe('Cloud HTTP: retries and plain failures', () => {
  it('waits and retries when the provider is busy, and gives up after three tries', async () => {
    const { http, calls } = stubHttp([{ fail: 429, headers: { 'retry-after': '0' } }, { fail: 503 }, { status: 200, data: { ok: true } }]);
    expect((await cloudRequest(http as never, 'Google Drive', { url: 'https://x' })).data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);

    const busy = stubHttp([{ fail: 503 }, { fail: 503 }, { fail: 503 }, { status: 200 }]);
    await expect(cloudRequest(busy.http as never, 'OneDrive', { url: 'https://x' })).rejects.toMatchObject({ kind: 'unavailable', message: 'OneDrive couldn’t be reached. Try again in a minute.' });
    expect(busy.calls).toHaveLength(3);
  }, 15_000);

  it('never repeats a POST unless told it is safe to', async () => {
    const { http, calls } = stubHttp([{ fail: 503 }, { status: 200 }]);
    await expect(cloudRequest(http as never, 'Google Drive', { method: 'post', url: 'https://x' })).rejects.toBeInstanceOf(CloudError);
    expect(calls).toHaveLength(1);
  });

  it('says what went wrong in words, by kind', async () => {
    const kinds = async (reply: Reply) => cloudRequest(stubHttp([reply]).http as never, 'Google Drive', { url: 'https://x', retry: false }).catch((e: CloudError) => e.kind);
    expect(await kinds({ fail: 401 })).toBe('auth');
    expect(await kinds({ fail: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } })).toBe('auth');
    expect(await kinds({ fail: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'slow down' } } })).toBe('rate_limit');
    expect(await kinds({ fail: 403, data: { error: { message: 'Insufficient permissions' } } })).toBe('permission');
    expect(await kinds({ fail: 404 })).toBe('not_found');
    expect(await kinds({ fail: 403, data: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } })).toBe('too_large');
  });
});

describe('Google Drive adapter', () => {
  it('asks for full Drive access with a refresh token, and lists a folder folders-first without the trash', async () => {
    const { http, calls } = stubHttp([{ data: { files: [{ id: 'f1', name: 'Acme', mimeType: 'application/vnd.google-apps.folder', parents: ['p'] }], nextPageToken: 'next' } }]);
    const google = new GoogleDriveProvider(http as never, config as never);
    const url = new URL(google.authorizeUrl('STATE'));
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe('http://api/cloud-files/google/callback');

    const page = await google.list('token', 'p', { sort: 'modified' });
    expect(page).toEqual({ items: [expect.objectContaining({ id: 'f1', name: 'Acme', kind: 'folder' })], cursor: 'next' });
    expect(calls[0].params).toMatchObject({ q: "'p' in parents and trashed = false", orderBy: 'folder,modifiedTime desc', supportsAllDrives: true });
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('keeps a search term inside its quotes, and refuses a folder id that isn’t one', async () => {
    const { http, calls } = stubHttp([{ data: { files: [] } }]);
    const google = new GoogleDriveProvider(http as never, config as never);
    await google.search('token', { query: "O'Brien\\x", type: 'pdf' });
    expect(calls[0].params.q).toBe("trashed = false and (name contains 'O\\'Brien\\\\x' or fullText contains 'O\\'Brien\\\\x') and mimeType = 'application/pdf'");
    await expect(google.list('token', "x' or '1'='1", {})).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('uploads through a resumable session in pieces, under a free name', async () => {
    const file = path.join(os.tmpdir(), `jest-cloud-${Date.now()}.bin`);
    await fs.writeFile(file, Buffer.alloc(9 * 1024 * 1024, 1));
    const { http, calls } = stubHttp([
      { data: { files: [{ id: 'old', name: 'big.bin', mimeType: 'application/octet-stream' }] } }, // "big.bin" is taken
      { data: { files: [] } }, // "big (2).bin" is free
      { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=1' }, data: {} },
      { status: 308, data: {} },
      { status: 200, data: { id: 'new', name: 'big (2).bin', mimeType: 'application/octet-stream', parents: ['p'] } },
    ]);
    const google = new GoogleDriveProvider(http as never, config as never);
    const item = await google.upload('token', 'p', 'big.bin', { path: file, size: 9 * 1024 * 1024, mimeType: 'application/octet-stream' });
    expect(item).toMatchObject({ id: 'new', name: 'big (2).bin' });
    expect(calls[2].data).toEqual({ name: 'big (2).bin', parents: ['p'] });
    expect(calls[3].headers).toMatchObject({ 'Content-Range': `bytes 0-${8 * 1024 * 1024 - 1}/${9 * 1024 * 1024}` });
    expect(calls[4].headers).toMatchObject({ 'Content-Range': `bytes ${8 * 1024 * 1024}-${9 * 1024 * 1024 - 1}/${9 * 1024 * 1024}` });
    await fs.unlink(file);
  });

  it('exports a Google document as an Office file to download, and as a PDF to preview', async () => {
    const doc = { id: 'd1', name: 'Proposal', mimeType: 'application/vnd.google-apps.document', parents: ['p'] };
    const { http, calls } = stubHttp([{ data: doc }, { data: 'bytes' }, { data: doc }, { data: 'bytes' }]);
    const google = new GoogleDriveProvider(http as never, config as never);
    expect((await google.download('token', 'd1')).name).toBe('Proposal.docx');
    expect(calls[1]).toMatchObject({ url: 'https://www.googleapis.com/drive/v3/files/d1/export' });
    const pdf = await google.download('token', 'd1', 'pdf');
    expect(pdf).toMatchObject({ name: 'Proposal.pdf', mimeType: 'application/pdf' });
  });
});

describe('OneDrive adapter', () => {
  it('signs in through "common" with the Files permission, and pages only back to Graph', async () => {
    const { http, calls } = stubHttp([
      { data: { value: [{ id: 'i1', name: 'Quote.pdf', size: 10, file: { mimeType: 'application/pdf' }, parentReference: { driveId: 'drv', id: 'root-id' } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' } },
      { data: { value: [] } },
    ]);
    const onedrive = new OneDriveProvider(http as never, config as never);
    const url = new URL(onedrive.authorizeUrl('STATE'));
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite.All');
    expect(url.searchParams.get('redirect_uri')).toBe('http://api/outlook/callback');

    const page = await onedrive.list('token', 'root', {});
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/root/children');
    expect(page.cursor).toBe('https://graph.microsoft.com/v1.0/next');
    // The item's id carries its drive, and opens it again.
    const id = page.items[0].id;
    await onedrive.list('token', id, {}).catch(() => undefined);
    expect(calls[1].url).toBe('https://graph.microsoft.com/v1.0/drives/drv/items/i1/children');
    // A "next page" address that isn't Graph's is never followed with the token.
    await expect(onedrive.list('token', 'root', { cursor: 'https://evil.example/steal' })).rejects.toMatchObject({ kind: 'bad_request' });
    expect(calls).toHaveLength(2);
    await expect(onedrive.get('token', 'not-a-ref!')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('opens a file shared with you in its owner’s drive', async () => {
    const { http } = stubHttp([
      {
        data: {
          value: [{ id: 'local', name: 'Plan.docx', remoteItem: { id: 'remote-id', name: 'Plan.docx', file: { mimeType: 'x' }, parentReference: { driveId: 'their-drive', id: 'their-folder' } } }],
        },
      },
    ]);
    const onedrive = new OneDriveProvider(http as never, config as never);
    const [item] = (await onedrive.list('token', 'shared', {})).items;
    expect(Buffer.from(item.id, 'base64url').toString()).toBe('their-drive|remote-id');
    expect(Buffer.from(item.parentId!, 'base64url').toString()).toBe('their-drive|their-folder');
  });

  it('uploads a small file in one request and a large one through a session, never sending the token to the session address', async () => {
    const small = path.join(os.tmpdir(), `jest-od-small-${Date.now()}.txt`);
    await fs.writeFile(small, 'hello');
    const one = stubHttp([{ data: { id: 'n1', name: 'a.txt', file: {}, parentReference: { driveId: 'drv', id: 'f' } } }]);
    const onedrive = new OneDriveProvider(one.http as never, config as never);
    await onedrive.upload('token', 'root', 'a b#.txt', { path: small, size: 5, mimeType: 'text/plain' });
    expect(one.calls[0]).toMatchObject({ method: 'put', url: 'https://graph.microsoft.com/v1.0/me/drive/root:/a%20b%23.txt:/content', params: { '@microsoft.graph.conflictBehavior': 'rename' } });

    const large = path.join(os.tmpdir(), `jest-od-large-${Date.now()}.bin`);
    const size = 5 * 1024 * 1024;
    await fs.writeFile(large, Buffer.alloc(size, 2));
    const two = stubHttp([
      { data: { uploadUrl: 'https://upload.sharepoint.test/session' } },
      { status: 201, data: { id: 'n2', name: 'big.bin', file: {}, parentReference: { driveId: 'drv', id: 'f' } } },
    ]);
    const graph = new OneDriveProvider(two.http as never, config as never);
    await graph.upload('token', 'root', 'big.bin', { path: large, size, mimeType: 'application/octet-stream' });
    expect(two.calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/big.bin:/createUploadSession');
    expect(two.calls[1].url).toBe('https://upload.sharepoint.test/session');
    expect(two.calls[1].headers).not.toHaveProperty('Authorization');
    expect(two.calls[1].headers).toMatchObject({ 'Content-Range': `bytes 0-${size - 1}/${size}` });
    await fs.unlink(small);
    await fs.unlink(large);
  });

  it('finds the folder of that name instead of making a second one', async () => {
    const { http, calls } = stubHttp([{ data: { id: 'existing', name: 'Acme', folder: {}, parentReference: { driveId: 'drv', id: 'root-id' } } }]);
    const onedrive = new OneDriveProvider(http as never, config as never);
    const folder = await onedrive.createFolder('token', 'root', 'Acme');
    expect(Buffer.from(folder.id, 'base64url').toString()).toBe('drv|existing');
    expect(calls).toHaveLength(1);
  });
});
