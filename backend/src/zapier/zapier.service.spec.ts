import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ZapierService } from './zapier.service';

describe('ZapierService', () => {
  const catalogs = { findOne: jest.fn(), deleteOne: jest.fn() };
  const connection = { collection: () => catalogs } as never;
  const jwt = { sign: () => 'service-jwt' } as never;
  const config = { get: () => 'http://agent' } as never;
  let integrations: {
    resolveAuth: jest.Mock;
    connectWithAuth: jest.Mock;
    disconnect: jest.Mock;
  };
  let http: { post: jest.Mock };
  let service: ZapierService;

  beforeEach(() => {
    integrations = {
      resolveAuth: jest.fn(),
      connectWithAuth: jest.fn(),
      disconnect: jest.fn(),
    };
    http = { post: jest.fn() };
    catalogs.findOne.mockReset();
    catalogs.deleteOne.mockReset();
    service = new ZapierService(integrations as never, http as never, jwt, connection, config);
  });

  it('saves the token, discovers actions and reports apps without ever returning the token', async () => {
    integrations.resolveAuth.mockResolvedValueOnce(null).mockResolvedValue({
      authType: 'bearer',
      credentials: { bearerToken: 'zap-secret-token-123456' },
    });
    http.post.mockReturnValue(of({ data: {} }));
    catalogs.findOne.mockResolvedValue({
      mode: 'managed',
      apps: [{ app: 'Hoops', read: [], write: ['Create Customer'] }],
      tools: [{}],
    });

    const status = await service.connect('org-1', 'Bearer zap-secret-token-123456');

    expect(integrations.connectWithAuth).toHaveBeenCalledWith('org-1', 'zapier', {
      authType: 'bearer',
      credentials: { bearerToken: 'zap-secret-token-123456' },
    });
    expect(http.post).toHaveBeenCalledWith(
      'http://agent/integrations/zapier/discover',
      {},
      expect.objectContaining({
        headers: { Authorization: 'Bearer service-jwt' },
      }),
    );
    expect(status).toMatchObject({
      connected: true,
      mode: 'managed',
      toolCount: 1,
      apps: [{ app: 'Hoops' }],
    });
    expect(JSON.stringify(status)).not.toContain('zap-secret-token-123456');
  });

  it('removes a rejected token and passes Zapier’s reason on', async () => {
    integrations.resolveAuth.mockResolvedValue(null);
    http.post.mockReturnValue(
      throwError(() => ({
        response: {
          status: 422,
          data: { detail: 'Zapier rejected the connection token.' },
        },
      })),
    );

    await expect(service.connect('org-1', 'bad-token-0123456789')).rejects.toThrow(new BadRequestException('Zapier rejected the connection token.'));
    expect(integrations.disconnect).toHaveBeenCalledWith('org-1', 'zapier');
    expect(catalogs.deleteOne).toHaveBeenCalledWith({
      organizationId: 'org-1',
    });
  });

  it('puts the previous working token back when a new one is rejected', async () => {
    const previous = {
      authType: 'bearer',
      credentials: { bearerToken: 'old-good-token-123456' },
    };
    integrations.resolveAuth.mockResolvedValue(previous);
    http.post
      .mockReturnValueOnce(
        throwError(() => ({
          response: { status: 422, data: { detail: 'rejected' } },
        })),
      )
      .mockReturnValue(of({ data: {} }));

    await expect(service.connect('org-1', 'new-bad-token-123456')).rejects.toThrow('rejected');
    expect(integrations.connectWithAuth).toHaveBeenLastCalledWith('org-1', 'zapier', { authType: 'bearer', credentials: previous.credentials });
    expect(integrations.disconnect).not.toHaveBeenCalled();
  });
});
