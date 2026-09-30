import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { GorillaDashService } from './gorilladash.service';

const httpError = (status: number) => throwError(() => Object.assign(new Error(`HTTP ${status}`), { response: { status } }));

function makeService(http: { get: jest.Mock; post: jest.Mock }, saved: jest.Mock = jest.fn(async () => undefined)) {
  const integrations = {
    connectWithAuth: saved,
    resolveAuth: jest.fn(async () => null),
    disconnect: jest.fn(async () => undefined),
  };
  const service = new GorillaDashService(integrations as never, http as never, { get: () => undefined } as never);
  return { service, integrations };
}

describe('GorillaDashService', () => {
  it('verifies against /ping (201 is success) with the key, secret and XHR headers, then saves the pair', async () => {
    const http = { get: jest.fn((..._args: unknown[]) => of({ status: 201, data: {} })), post: jest.fn(() => of({ status: 201, data: {} })) };
    const { service, integrations } = makeService(http);
    const result = await service.connect('org-1', 'key-12345678', 'secret-12345678');

    const [url, options] = http.get.mock.calls[0] as unknown as [string, { headers: Record<string, string>; validateStatus: (s: number) => boolean }];
    expect(url).toBe('https://api.gorilladash.com/api/v1/ping');
    expect(options.headers).toMatchObject({
      'GorillaDash-Api-Key': 'key-12345678',
      'GorillaDash-Api-Secret': 'secret-12345678',
      'X-Requested-With': 'XMLHttpRequest',
    });
    expect(options.validateStatus(201)).toBe(true);
    expect(options.validateStatus(200)).toBe(true);
    expect(options.validateStatus(401)).toBe(false);
    expect(integrations.connectWithAuth).toHaveBeenCalledWith('org-1', 'gorilladash', {
      authType: 'basic',
      credentials: { username: 'key-12345678', password: 'secret-12345678' },
      baseUrl: 'https://api.gorilladash.com',
    });
    expect(result).toEqual({ connected: true, keyMasked: expect.stringMatching(/^key-.*78$/), keyScope: 'organization' });
    expect(result.keyMasked).not.toContain('12345');
  });

  it.each([
    [401, /didn’t accept this API key/],
    [403, /API isn’t turned on/],
    [500, /HTTP 500/],
  ])('HTTP %s -> a readable error and nothing saved', async (status, message) => {
    const http = { get: jest.fn(() => httpError(status)), post: jest.fn() };
    const { service, integrations } = makeService(http);
    const attempt = service.connect('org-1', 'key-12345678', 'secret-12345678');
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.connect('org-1', 'key-12345678', 'secret-12345678')).rejects.toThrow(message);
    expect(integrations.connectWithAuth).not.toHaveBeenCalled();
  });

  it('recognises a location ("tribe") key by the 403 on location search', async () => {
    const http = { get: jest.fn(() => of({ status: 201, data: {} })), post: jest.fn(() => httpError(403)) };
    const { service } = makeService(http);
    expect((await service.connect('org-1', 'key-12345678', 'secret-12345678')).keyScope).toBe('location');
  });
});
