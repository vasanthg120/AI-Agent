import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { buildAuthHeaders } from './auth-methods';
import { normalizeError, normalizeSuccess, NormalizedExecutionResult } from './error-normalizer';
import { IntegrationsService } from './integrations.service';
import { IntegrationEndpoint, IntegrationEndpointDocument } from './schemas/integration-endpoint.schema';
import { IntegrationResource, IntegrationResourceDocument } from './schemas/integration-resource.schema';

export interface ExecuteParams {
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

// The one generic executor every configured endpoint (any provider, any
// resource, any action) runs through — deliberately has no provider-specific
// branches. Given an integration's stored auth (IntegrationsService.
// resolveAuth) and an endpoint's stored method/path/schema
// (integration-endpoint.schema.ts), this is enough to call any REST API.
@Injectable()
export class DynamicExecutorService {
  constructor(
    @InjectModel(IntegrationResource.name) private resourceModel: Model<IntegrationResourceDocument>,
    @InjectModel(IntegrationEndpoint.name) private endpointModel: Model<IntegrationEndpointDocument>,
    private integrationsService: IntegrationsService,
    private http: HttpService,
  ) {}

  async execute(
    organizationId: string,
    provider: string,
    resourceKey: string,
    endpointKey: string,
    params: ExecuteParams,
  ): Promise<NormalizedExecutionResult> {
    const auth = await this.integrationsService.resolveAuth(organizationId, provider);
    if (!auth) throw new NotFoundException(`No integration connected for provider "${provider}".`);
    if (!auth.baseUrl) throw new BadRequestException(`Integration "${provider}" has no base URL configured.`);

    const resource = await this.resourceModel.findOne({ integrationId: auth.integrationId, key: resourceKey });
    if (!resource) throw new NotFoundException(`Resource "${resourceKey}" not found for "${provider}".`);

    const endpoint = await this.endpointModel.findOne({ resourceId: resource._id, key: endpointKey });
    if (!endpoint) {
      throw new NotFoundException(`Endpoint "${endpointKey}" not found under resource "${resourceKey}".`);
    }

    const path = this.fillPathTemplate(endpoint.path, params.pathParams ?? {});
    const url = `${auth.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

    await assertPublicHttpUrl(url);

    const missingQuery = (endpoint.queryParams ?? [])
      .filter((q) => q.required && !(params.query ?? {})[q.name])
      .map((q) => q.name);
    if (missingQuery.length > 0) {
      throw new BadRequestException(`Missing required query param(s): ${missingQuery.join(', ')}`);
    }

    // Endpoint's static headers first, then this integration's auth headers
    // — auth headers win on a name collision, decided explicitly rather
    // than left to object-spread order accidentally.
    const staticHeaders = Object.fromEntries((endpoint.headers ?? []).map((h) => [h.name, h.value]));
    const authHeaders = buildAuthHeaders(auth.authType, auth.credentials);
    // Xero requires this header on every API call in addition to the
    // standard Authorization: Bearer — unlike Zoho/Salesforce, where the
    // per-customer API host itself differs (resolved into baseUrl above),
    // Xero has one fixed global host and distinguishes tenants by this
    // header instead. Scoped narrowly to this one provider; every other
    // oauth2 provider's auth.oauthMeta is simply ignored here.
    const providerHeaders = provider === 'xero' && auth.oauthMeta?.tenantId ? { 'Xero-tenant-id': auth.oauthMeta.tenantId } : {};
    // Zoho's API rejects the generic 'Bearer <token>' scheme buildAuthHeaders
    // uses by default for every other oauth2 provider — it specifically
    // requires 'Zoho-oauthtoken <token>' (see auth-methods.ts's own comment
    // on this). Zoho CRM's real sync calls never reach this generic path
    // (crm_adapters.py builds its own correct header in Python), but Zoho
    // Books has no such separate path — every real Books request DOES go
    // through here — so this override is load-bearing for Books, and a
    // correctness fix (not a behavior change) for any admin-configured
    // custom Zoho CRM endpoint too.
    const authOverride =
      (provider === 'zoho' || provider === 'zohobooks' || provider === 'zohopayroll') && auth.authType === 'oauth2' && auth.credentials.accessToken
        ? { Authorization: `Zoho-oauthtoken ${auth.credentials.accessToken}` }
        : {};
    // MYOB needs three headers beyond Authorization: Bearer, confirmed from
    // MYOB's own current docs (developer.myob.com) — x-myobapi-key (the
    // OAuth client id, stored at connect time since it's needed again on
    // every later call, not just the original authorize request) and the
    // fixed x-myobapi-version, plus x-myobapi-cftoken: a SEPARATE
    // company-file username/password pair (never the OAuth token), Base64
    // "username:password" — see myob.service.ts/IntegrationsService.
    // saveSecondaryCredentials. Omitted entirely until that second
    // credential pair has actually been entered, so a half-finished MYOB
    // connection fails with a clear 401 from MYOB rather than a malformed
    // header.
    const myobHeaders =
      provider === 'myob' && auth.oauthMeta?.myobClientId
        ? {
            'x-myobapi-key': auth.oauthMeta.myobClientId,
            'x-myobapi-version': 'v2',
            ...(auth.secondaryCredentials
              ? { 'x-myobapi-cftoken': Buffer.from(`${auth.secondaryCredentials.username}:${auth.secondaryCredentials.password}`).toString('base64') }
              : {}),
          }
        : {};
    const headers = { ...staticHeaders, ...authHeaders, ...providerHeaders, ...authOverride, ...myobHeaders };

    // Zoho Books/Zoho Payroll both require organization_id on every API call
    // (which "organisation" within the connected Zoho account to read/write
    // — see zohobooks.service.ts/zohopayroll.service.ts's post-connect
    // selection) — a query param, not a header, so it's injected here
    // rather than alongside Xero's header above. An endpoint-supplied
    // organization_id (if the admin configured one explicitly) is never
    // overridden. The two providers' selected org ids live under different
    // oauthMeta keys (booksOrganizationId/payrollOrganizationId), so a
    // connection to one never leaks its org id into a call for the other.
    const providerQuery =
      provider === 'zohobooks' && auth.oauthMeta?.booksOrganizationId
        ? { organization_id: auth.oauthMeta.booksOrganizationId }
        : provider === 'zohopayroll' && auth.oauthMeta?.payrollOrganizationId
          ? { organization_id: auth.oauthMeta.payrollOrganizationId }
          : {};
    const query = { ...providerQuery, ...params.query };

    const integrationId = auth.integrationId.toString();
    const endpointId = (endpoint._id as { toString(): string }).toString();

    try {
      const response = await firstValueFrom(
        this.http.request({
          method: endpoint.method,
          url,
          headers,
          params: query,
          data: params.body,
          timeout: endpoint.timeoutMs ?? 15_000,
        }),
      );
      return normalizeSuccess(integrationId, endpointId, response.status, response.data);
    } catch (err) {
      return normalizeError(integrationId, endpointId, err);
    }
  }

  private fillPathTemplate(path: string, pathParams: Record<string, string>): string {
    return path.replace(/\{([^}]+)\}/g, (match, token: string) => {
      const value = pathParams[token];
      if (value === undefined) {
        throw new BadRequestException(`Missing required path param "${token}" for this endpoint.`);
      }
      return encodeURIComponent(value);
    });
  }
}
