import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { SalesforceService } from './salesforce.service';

// Same shape as zoho/zoho.service.spec.ts — see that file's own comment for
// why this is unit-level (persistence is IntegrationsService.connectWithOAuth's
// job, covered against real Mongo in integrations/integrations-oauth.spec.ts).
describe('SalesforceService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const config = {
    get: (key: string) => {
      const values: Record<string, string> = {
        'integrations.salesforce.clientId': 'client-id',
        'integrations.salesforce.clientSecret': 'client-secret',
        'integrations.salesforce.redirectUri': 'http://localhost:3000/salesforce/callback',
        'integrations.salesforce.authBaseUrl': 'https://login.salesforce.com',
      };
      return values[key];
    },
  } as never;

  it('buildAuthorizeUrl requests the refresh_token scope, and signs organizationId into state', () => {
    const http = { post: jest.fn() };
    const integrations = { connectWithOAuth: jest.fn(), disconnect: jest.fn() };
    const crmIntegrations = { rediscover: jest.fn() };
    const service = new SalesforceService(config, http as never, jwt, integrations as never, crmIntegrations as never);

    const url = new URL(service.buildAuthorizeUrl('org-1'));
    expect(url.origin + url.pathname).toBe('https://login.salesforce.com/services/oauth2/authorize');
    expect(url.searchParams.get('scope')).toContain('refresh_token');
    const state = jwt.verify<{ organizationId: string; purpose: string }>(url.searchParams.get('state')!);
    expect(state).toMatchObject({ organizationId: 'org-1', purpose: 'salesforce-oauth' });
  });

  it('handleCallback rejects a state signed for a different purpose', async () => {
    const http = { post: jest.fn() };
    const integrations = { connectWithOAuth: jest.fn(), disconnect: jest.fn() };
    const crmIntegrations = { rediscover: jest.fn() };
    const service = new SalesforceService(config, http as never, jwt, integrations as never, crmIntegrations as never);

    const wrongPurposeState = jwt.sign({ organizationId: 'org-1', purpose: 'zoho-oauth' });
    await expect(service.handleCallback('code', wrongPurposeState)).rejects.toThrow(UnauthorizedException);
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  it('on success: saves the token pair with instance_url, and runs discovery', async () => {
    const http = { post: jest.fn().mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', instance_url: 'https://my-org.my.salesforce.com' } })) };
    const integrations = { connectWithOAuth: jest.fn().mockResolvedValue({ connected: true }), disconnect: jest.fn() };
    const crmIntegrations = { rediscover: jest.fn().mockResolvedValue({ status: 'ok', modules: {} }) };
    const service = new SalesforceService(config, http as never, jwt, integrations as never, crmIntegrations as never);

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'salesforce-oauth' });
    await service.handleCallback('auth-code', state);

    expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
      'org-1',
      'salesforce',
      expect.objectContaining({ accessToken: 'at', refreshToken: 'rt', oauthMeta: { instanceUrl: 'https://my-org.my.salesforce.com' } }),
      { skipSync: true },
    );
    expect(integrations.disconnect).not.toHaveBeenCalled();
  });

  it('rolls back exactly once when the post-connect discovery check fails', async () => {
    const http = { post: jest.fn().mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', instance_url: 'https://my-org.my.salesforce.com' } })) };
    const integrations = { connectWithOAuth: jest.fn().mockResolvedValue({ connected: true }), disconnect: jest.fn().mockResolvedValue(undefined) };
    const crmIntegrations = { rediscover: jest.fn().mockResolvedValue({ status: 'error', message: 'denied' }) };
    const service = new SalesforceService(config, http as never, jwt, integrations as never, crmIntegrations as never);

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'salesforce-oauth' });
    await expect(service.handleCallback('auth-code', state)).rejects.toThrow();
    expect(integrations.disconnect).toHaveBeenCalledWith('org-1', 'salesforce');
    expect(integrations.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rolls back when Salesforce does not return a complete token response (e.g. missing instance_url)', async () => {
    const http = { post: jest.fn().mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt' } })) };
    const integrations = { connectWithOAuth: jest.fn(), disconnect: jest.fn() };
    const crmIntegrations = { rediscover: jest.fn() };
    const service = new SalesforceService(config, http as never, jwt, integrations as never, crmIntegrations as never);

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'salesforce-oauth' });
    await expect(service.handleCallback('auth-code', state)).rejects.toThrow();
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });
});
