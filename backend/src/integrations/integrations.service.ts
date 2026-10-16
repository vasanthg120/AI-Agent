import { HttpService } from '@nestjs/axios';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { crmProviderForIntegration } from '../data-sources/provider-catalog';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { EncryptionService } from '../common/encryption/encryption.service';
import { AuthCredentials, AuthType, buildAuthHeaders, requiredCredentialFields } from './auth-methods';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { getProviderRule, ProviderRule } from './provider-rules';
import { IntegrationCredential, IntegrationCredentialDocument } from './schemas/integration-credential.schema';

// The two provider slugs a connected CRM is ever stored under (the fixed
// 'crm' card's legacy apiKey path, or the generic Custom Integration flow
// using the external CRM's own connector id) — see prospectconnect.py's
// resolve_credentials for why both are checked everywhere else too.
// Every CRM HaiVE can take data from (the customised CRM, HubSpot,
// Salesforce, Zoho…) — see data-sources/provider-catalog.ts.

const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// The platform-wide AI provider credentials Platform Admin manages (see
// AdminIntegrationsController) — the only providers python-agent's
// /admin/providers/:provider/verify route accepts.
export const PLATFORM_PROVIDERS = ['anthropic', 'sarvam', 'elevenlabs', 'groq'] as const;
export type PlatformProvider = (typeof PLATFORM_PROVIDERS)[number];

export interface IntegrationStatus {
  connected: boolean;
  authType?: AuthType;
  maskedKey?: string;
  baseUrl?: string;
}

export interface IntegrationSummary extends IntegrationStatus {
  provider: string;
  // Customer-facing name — never the raw provider slug for a
  // white-labeled provider like 'prospectconnect' (see provider-rules.ts).
  label: string;
  connectedAt?: Date;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(IntegrationCredential.name)
    private credentialModel: Model<IntegrationCredentialDocument>,
    private encryption: EncryptionService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
    private dataSources: DataSourcesService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  /** The actual sync call, awaited — used both by the fire-and-forget
   * post-connect trigger below and by the explicit "Sync Now" endpoint
   * (POST /integrations/crm/sync), which needs a real result to show the
   * user rather than firing blind. Throws on failure (e.g. python-agent
   * unreachable) so callers can decide how to surface that.
   *
   * Uses its own longer timeout, NOT the module's 15s default — that default
   * is sized for Test Connection / Dynamic Executor calls to arbitrary
   * customer endpoints (see integrations.module.ts), which should fail fast.
   * This call instead drives python-agent's sync_deals_for_org +
   * sync_quotes_for_org, a sequential, paginated crawl of the org's whole
   * CRM (up to 50 pages of 100 records each, for deals and then quotes) —
   * routinely well past 15s for a real org, which is exactly why "Sync Now"
   * was timing out with a plain AxiosError even though python-agent itself
   * was healthy and still working on the request. */
  async syncCrmNow(organizationId: string): Promise<{ dealsSynced: number; quotesSynced: number }> {
    const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '10m' });
    const { data } = await firstValueFrom(
      this.http.post<{ dealsSynced: number; quotesSynced: number }>(
        `${this.pythonAgentUrl}/sync/crm/run-for-org`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 180_000 },
      ),
    );
    return data;
  }

  /** Fires an immediate, org-scoped CRM sync right after a customer connects
   * (or reconnects) their CRM — without this, real data only shows up on
   * the dashboard after the next crm_mongo_sync_interval_minutes poll (up to
   * 10 minutes of an apparently-connected-but-empty dashboard, which is
   * exactly the "doesn't fetch automatically" complaint). Best-effort and
   * never blocks/fails the connect response — mirrors business-profile.
   * service.ts's post-save Qdrant sync call. Scoped to CRM providers (see
   * data-sources/provider-catalog.ts); every other provider (Anthropic,
   * Stripe, a customer's own custom REST API, ...) has nothing to sync. */
  private triggerCrmSyncIfApplicable(organizationId: string, provider: string): void {
    if (!crmProviderForIntegration(provider)) return;
    // The CRM becomes its own data source first, so what the sync writes is
    // tagged with it from the very first record.
    this.dataSources
      .reconcile(organizationId)
      .then(() => this.syncCrmNow(organizationId))
      .catch((err) => {
        this.logger.error(`Immediate CRM sync failed for org ${organizationId}: ${(err as Error).message}`);
      });
  }

  /** Legacy shape, request/response byte-for-byte unchanged: apiKey (+
   * optional baseUrl), used by the 'anthropic' and 'crm' connect UI today.
   * The stored value is now encrypted at rest (was plaintext) — every read
   * site goes through decryptStoredApiKey() below, which also transparently
   * upgrades any row still holding an old plaintext value. */
  async connect(organizationId: string, provider: string, apiKey: string, baseUrl?: string): Promise<{ connected: true; maskedKey: string; baseUrl?: string }> {
    this.assertAllowed(provider);
    await this.credentialModel.findOneAndUpdate(
      { organizationId, provider },
      { organizationId, provider, apiKey: this.encryption.encrypt(apiKey), baseUrl, authType: undefined, credentialsEncrypted: undefined },
      { upsert: true },
    );
    this.triggerCrmSyncIfApplicable(organizationId, provider);
    return { connected: true, maskedKey: this.mask(apiKey), baseUrl };
  }

  /** Flexible path — any of auth-methods.ts's AuthType styles. Used when the
   * request DTO sets `authType`; connect() above is untouched for requests
   * that don't. */
  async connectWithAuth(
    organizationId: string,
    provider: string,
    dto: ConnectIntegrationDto,
    // The setup wizard reviews the field mapping before the first sync, so it
    // asks for the connection to be saved without starting one.
    options: { skipSync?: boolean } = {},
  ): Promise<{ connected: true; authType: AuthType; baseUrl?: string }> {
    const authType = dto.authType!;
    this.assertAllowed(provider, authType);
    const credentials = (dto.credentials ?? {}) as AuthCredentials;

    const missing = requiredCredentialFields(authType).filter((field) => !credentials[field]);
    if (missing.length > 0) {
      throw new BadRequestException(`Missing required field(s) for ${authType}: ${missing.join(', ')}`);
    }

    await this.credentialModel.findOneAndUpdate(
      { organizationId, provider },
      {
        organizationId,
        provider,
        authType,
        credentialsEncrypted: this.encryption.encrypt(JSON.stringify(credentials)),
        baseUrl: dto.baseUrl,
        healthCheckPath: dto.healthCheckPath,
        apiKey: undefined,
      },
      { upsert: true },
    );
    if (options.skipSync) {
      if (crmProviderForIntegration(provider)) await this.dataSources.reconcile(organizationId);
    } else {
      this.triggerCrmSyncIfApplicable(organizationId, provider);
    }
    return { connected: true, authType, baseUrl: dto.baseUrl };
  }

  /** Saves an OAuth2 CRM connection (Zoho/Salesforce — see ../zoho/,
   * ../salesforce/) after their dedicated controller's callback already
   * completed the authorization-code exchange. Parallel to connectWithAuth()
   * above but for the one authType (oauth2) that carries a refresh token +
   * expiry + provider-specific metadata those other auth styles never need —
   * kept as its own method rather than overloading connectWithAuth's DTO so
   * every existing caller of that method is completely unaffected. */
  async connectWithOAuth(
    organizationId: string,
    provider: string,
    tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number; oauthMeta?: Record<string, string>; baseUrl?: string },
    options: { skipSync?: boolean } = {},
  ): Promise<{ connected: true }> {
    this.assertAllowed(provider, 'oauth2');
    await this.credentialModel.findOneAndUpdate(
      { organizationId, provider },
      {
        organizationId,
        provider,
        authType: 'oauth2',
        credentialsEncrypted: this.encryption.encrypt(JSON.stringify({ accessToken: tokens.accessToken })),
        refreshTokenEncrypted: this.encryption.encrypt(tokens.refreshToken),
        tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
        oauthMeta: tokens.oauthMeta,
        baseUrl: tokens.baseUrl,
        // A fresh connect/reconnect through this same path is also how a
        // needs_reauth row recovers — explicitly clearing it here (not just
        // relying on the field being absent from this update) covers the
        // reconnect case, where the existing doc already has it set.
        status: 'connected',
        apiKey: undefined,
      },
      { upsert: true },
    );
    if (options.skipSync) {
      if (crmProviderForIntegration(provider)) await this.dataSources.reconcile(organizationId);
    } else {
      this.triggerCrmSyncIfApplicable(organizationId, provider);
    }
    return { connected: true };
  }

  /** Saves (or replaces) an organization's OWN OAuth app credentials for a
   * provider — currently only Zoho (see zoho.service.ts's resolveAppCredentials)
   * — BEFORE any OAuth round trip happens. A narrow $set, deliberately not a
   * full upsert like connectWithOAuth()/connectWithAuth() above: this must
   * never clear an already-connected row's accessToken/refreshToken/
   * tokenExpiresAt/status (an org replacing their app credentials after
   * connecting shouldn't silently disconnect them — the next refresh will
   * simply start using the new client id/secret). The secret is encrypted
   * the same way every other secret in this collection is; the client id is
   * plaintext (not a secret — Zoho/Google/Microsoft client ids are visible
   * in the browser's own address bar during the OAuth redirect). */
  async saveOAuthAppCredentials(
    organizationId: string,
    provider: string,
    app: { clientId: string; clientSecret: string; meta?: Record<string, string> },
  ): Promise<void> {
    await this.credentialModel.findOneAndUpdate(
      { organizationId, provider },
      {
        $set: {
          organizationId,
          provider,
          oauthClientId: app.clientId,
          oauthClientSecretEncrypted: this.encryption.encrypt(app.clientSecret),
          ...(app.meta ? { oauthMeta: app.meta } : {}),
        },
      },
      { upsert: true },
    );
  }

  /** Status for the credential-entry modal — never returns the real secret,
   * only whether one is on file and a fixed masked placeholder, same
   * "don't even decrypt just to mask" approach status()/listCustom() above
   * already use for apiKey. */
  async getOAuthAppCredentialsStatus(
    organizationId: string,
    provider: string,
  ): Promise<{ configured: boolean; clientId?: string; clientSecretMasked?: string; meta?: Record<string, string> }> {
    const doc = await this.credentialModel.findOne({ organizationId, provider }, { oauthClientId: 1, oauthClientSecretEncrypted: 1, oauthMeta: 1 });
    if (!doc?.oauthClientId || !doc?.oauthClientSecretEncrypted) return { configured: false };
    return { configured: true, clientId: doc.oauthClientId, clientSecretMasked: '••••••••••••', meta: doc.oauthMeta };
  }

  /** Decrypted app credentials for internal, server-side use ONLY (building
   * the authorize URL and exchanging the code — zoho.service.ts) — never
   * exposed over HTTP; getOAuthAppCredentialsStatus() above is the
   * HTTP-facing, masked equivalent. Returns null if the organization hasn't
   * configured its own app, so the caller can fall back to the platform's
   * shared app credentials. */
  async resolveOAuthAppCredentials(
    organizationId: string,
    provider: string,
  ): Promise<{ clientId: string; clientSecret: string; meta?: Record<string, string> } | null> {
    const doc = await this.credentialModel.findOne({ organizationId, provider }, { oauthClientId: 1, oauthClientSecretEncrypted: 1, oauthMeta: 1 });
    if (!doc?.oauthClientId || !doc?.oauthClientSecretEncrypted) return null;
    return { clientId: doc.oauthClientId, clientSecret: this.encryption.decrypt(doc.oauthClientSecretEncrypted), meta: doc.oauthMeta };
  }

  /** Refreshes an oauth2 credential if its access token is expired/near
   * expiry, persists the result, and returns the (possibly refreshed)
   * decrypted token — called from resolveAuth() below so every consumer of
   * that method (DynamicExecutorService, Test Connection) transparently gets
   * a live token without having to know Zoho/Salesforce tokens expire at
   * all. Mirrors python-agent's app/integrations/oauth_refresh.py exactly
   * (same buffer, same needs_reauth-on-failure behavior) — that copy exists
   * because the CRM sync engine reads Mongo directly from Python rather than
   * through this service; both must agree on the stored shape, not the
   * refresh call path itself. Returns null (never throws) on any failure —
   * callers fall back to whatever was already on file, which will then fail
   * its own request with a normal 401 rather than a confusing 500 here. */
  private async refreshOAuthToken(doc: IntegrationCredentialDocument): Promise<string | null> {
    const EXPIRY_BUFFER_MS = 60_000;
    if (doc.tokenExpiresAt && doc.tokenExpiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS) {
      const current = JSON.parse(this.encryption.decrypt(doc.credentialsEncrypted!)) as AuthCredentials;
      return current.accessToken ?? null;
    }
    if (doc.status === 'needs_reauth' || !doc.refreshTokenEncrypted) return null;

    try {
      const refreshToken = this.encryption.decrypt(doc.refreshTokenEncrypted);
      const oauthMeta = doc.oauthMeta ?? {};
      let refreshed: { accessToken: string; expiresInSeconds: number; oauthMeta: Record<string, string> };

      if (doc.provider === 'zoho') {
        const base = oauthMeta.accountsServer || this.config.get<string>('integrations.zoho.accountsBaseUrl') || 'https://accounts.zoho.com';
        // The organization's own Zoho API Console app (see
        // POST /zoho/app-credentials) takes priority over Haive's shared
        // platform app — a refresh MUST use the same client id/secret the
        // original authorization was issued under, or Zoho rejects it even
        // with a valid refresh token. Falls back to the platform env vars
        // only for an org that never configured its own (backward
        // compatible with every connection made before this existed).
        const clientId = doc.oauthClientId || this.config.get<string>('integrations.zoho.clientId') || '';
        const clientSecret = doc.oauthClientSecretEncrypted
          ? this.encryption.decrypt(doc.oauthClientSecretEncrypted)
          : this.config.get<string>('integrations.zoho.clientSecret') || '';
        const { data } = await firstValueFrom(
          this.http.post<{ access_token?: string; expires_in?: number; api_domain?: string; error?: string }>(
            `${base.replace(/\/$/, '')}/oauth/v2/token`,
            new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              client_id: clientId,
              client_secret: clientSecret,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
          ),
        );
        if (!data.access_token) throw new Error(data.error ?? 'Zoho did not return an access token');
        refreshed = {
          accessToken: data.access_token,
          expiresInSeconds: data.expires_in ?? 3600,
          oauthMeta: { ...oauthMeta, apiDomain: data.api_domain ?? oauthMeta.apiDomain ?? '' },
        };
      } else if (doc.provider === 'salesforce') {
        const base = oauthMeta.authBaseUrl || this.config.get<string>('integrations.salesforce.authBaseUrl') || 'https://login.salesforce.com';
        const { data } = await firstValueFrom(
          this.http.post<{ access_token?: string; instance_url?: string; error?: string; error_description?: string }>(
            `${base.replace(/\/$/, '')}/services/oauth2/token`,
            new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              client_id: this.config.get<string>('integrations.salesforce.clientId') ?? '',
              client_secret: this.config.get<string>('integrations.salesforce.clientSecret') ?? '',
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
          ),
        );
        if (!data.access_token) throw new Error(data.error_description ?? data.error ?? 'Salesforce did not return an access token');
        refreshed = {
          accessToken: data.access_token,
          // Salesforce doesn't return expires_in on refresh — same fixed,
          // conservative 2h re-check window python-agent's oauth_refresh.py uses.
          expiresInSeconds: 7200,
          oauthMeta: { ...oauthMeta, instanceUrl: data.instance_url ?? oauthMeta.instanceUrl ?? '' },
        };
      } else {
        return null;
      }

      await this.credentialModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            credentialsEncrypted: this.encryption.encrypt(JSON.stringify({ accessToken: refreshed.accessToken })),
            tokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
            oauthMeta: refreshed.oauthMeta,
          },
        },
      );
      return refreshed.accessToken;
    } catch (err) {
      this.logger.warn(`OAuth refresh failed for provider=${doc.provider} org=${doc.organizationId} — marking needs_reauth: ${(err as Error).message}`);
      await this.credentialModel.updateOne({ _id: doc._id }, { $set: { status: 'needs_reauth' } });
      return null;
    }
  }

  /** Routes to connect() or connectWithAuth() above based on whether the
   * request set authType — the single HTTP entry point (see
   * IntegrationsController), kept as one endpoint so the API surface
   * doesn't fork in two. */
  connectFromDto(organizationId: string, provider: string, dto: ConnectIntegrationDto) {
    if (dto.authType) return this.connectWithAuth(organizationId, provider, dto);
    return this.connect(organizationId, provider, dto.apiKey!, dto.baseUrl);
  }

  /** "Configured" (status() above — a DB-existence check) vs "actually
   * reachable right now" — this makes a real, minimal call using the
   * already-connected platform credential, via python-agent's new
   * /admin/providers/{provider}/verify route (it owns the actual API key,
   * this service never sees it decrypted here). Never throws on a bad/
   * expired key — that's a normal {ok:false} result, not a 500. */
  async verifyPlatformProvider(provider: PlatformProvider): Promise<{ ok: boolean; message: string }> {
    const token = this.jwt.sign({ sub: 'platform-admin' }, { expiresIn: '5m' });
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ ok: boolean; message: string }>(
          `${this.pythonAgentUrl}/admin/providers/${provider}/verify`,
          {},
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return data;
    } catch (err) {
      this.logger.error(`Provider verification failed for ${provider}: ${(err as Error).message}`);
      return { ok: false, message: 'Could not reach the AI service to verify this connection. Please try again.' };
    }
  }

  async status(organizationId: string, provider: string): Promise<IntegrationStatus> {
    this.assertAllowed(provider);
    const doc = await this.credentialModel.findOne({ organizationId, provider });
    if (!doc) return { connected: false };
    if (doc.authType) {
      // No single "key" to mask for bearer/basic/customHeaders — the fact
      // that credentials are on file plus which auth style is enough for
      // the UI to show without ever decrypting them for display.
      return { connected: true, authType: doc.authType, baseUrl: doc.baseUrl };
    }
    return { connected: true, maskedKey: this.mask(this.decryptStoredApiKey(doc.apiKey)), baseUrl: doc.baseUrl };
  }

  /** Every custom integration connected for this org — the "Custom
   * Integrations" list in IntegrationsPage.tsx. Excludes 'anthropic'/'crm'
   * (those already have their own fixed cards) so this only surfaces
   * providers the user actually typed in themselves. */
  async listCustom(organizationId: string): Promise<IntegrationSummary[]> {
    const docs = await this.credentialModel.find({ organizationId, provider: { $nin: ['anthropic', 'crm'] } }).sort({ createdAt: -1 });
    return docs.map((doc) => ({
      provider: doc.provider,
      label: getProviderRule(doc.provider).label,
      connected: true,
      authType: doc.authType,
      maskedKey: doc.authType ? undefined : this.mask(this.decryptStoredApiKey(doc.apiKey)),
      baseUrl: doc.baseUrl,
      connectedAt: (doc as unknown as { createdAt: Date }).createdAt,
    }));
  }

  async disconnect(organizationId: string, provider: string): Promise<void> {
    this.assertAllowed(provider);
    await this.credentialModel.deleteOne({ organizationId, provider });
    // A disconnected CRM's data source is kept (its history stays viewable)
    // but marked disconnected and never read by default or unified views.
    if (crmProviderForIntegration(provider)) await this.dataSources.reconcile(organizationId);
  }

  /** Pings the provider's baseUrl (+ optional healthCheckPath) with the
   * saved (or just-entered, pre-save) credentials' auth headers applied.
   * Never throws — every failure mode (DNS, timeout, 401/403, 5xx) is
   * translated into a friendly {ok:false, message} instead of a raw HTTP/
   * network error, per the "never expose raw errors" requirement. */
  async testConnection(organizationId: string, provider: string, dto: TestConnectionDto): Promise<{ ok: boolean; message: string }> {
    let baseUrl = dto.baseUrl;
    let healthCheckPath = dto.healthCheckPath;
    let authType = dto.authType;
    let credentials = dto.credentials as AuthCredentials | undefined;

    // No credentials in this test request — re-test the already-saved
    // connection instead of requiring the user to re-type everything.
    if (!authType && !dto.apiKey) {
      const doc = await this.credentialModel.findOne({ organizationId, provider });
      if (!doc) return { ok: false, message: 'Nothing connected yet for this provider.' };
      baseUrl = baseUrl ?? doc.baseUrl;
      healthCheckPath = healthCheckPath ?? doc.healthCheckPath;
      if (doc.authType) {
        authType = doc.authType;
        credentials = JSON.parse(this.encryption.decrypt(doc.credentialsEncrypted!)) as AuthCredentials;
      } else {
        authType = 'apiKeyBaseUrl';
        credentials = { apiKey: this.decryptStoredApiKey(doc.apiKey) };
      }
    } else if (!authType) {
      // Legacy-shaped test request (apiKey/baseUrl, no authType).
      authType = 'apiKeyBaseUrl';
      credentials = { apiKey: dto.apiKey };
    }

    if (!baseUrl) {
      return { ok: false, message: 'A base URL is required to test the connection.' };
    }

    const url = healthCheckPath ? `${baseUrl.replace(/\/$/, '')}/${healthCheckPath.replace(/^\//, '')}` : baseUrl;

    try {
      await assertPublicHttpUrl(url);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }

    const headers = buildAuthHeaders(authType, credentials ?? {});

    try {
      const response = await firstValueFrom(this.http.get(url, { headers, timeout: 10_000 }));
      return { ok: true, message: `Connected — received HTTP ${response.status}.` };
    } catch (err) {
      return { ok: false, message: this.friendlyErrorMessage(err) };
    }
  }

  /** The saved auth for (org, provider), normalized to one shape regardless
   * of whether it used the legacy apiKey-only path or the newer multi-auth
   * path — used by DynamicExecutorService so it doesn't need to duplicate
   * this decrypt-and-fallback logic. Returns null if nothing is connected. */
  async resolveAuth(
    organizationId: string,
    provider: string,
  ): Promise<{ integrationId: Types.ObjectId; authType: AuthType; credentials: AuthCredentials; baseUrl?: string } | null> {
    const doc = await this.credentialModel.findOne({ organizationId, provider });
    if (!doc) return null;
    if (doc.authType === 'oauth2') {
      const accessToken = await this.refreshOAuthToken(doc);
      return {
        integrationId: doc._id,
        authType: doc.authType,
        credentials: { accessToken: accessToken ?? undefined },
        baseUrl: doc.oauthMeta?.apiDomain || doc.oauthMeta?.instanceUrl || doc.baseUrl,
      };
    }
    if (doc.authType) {
      return {
        integrationId: doc._id,
        authType: doc.authType,
        credentials: JSON.parse(this.encryption.decrypt(doc.credentialsEncrypted!)) as AuthCredentials,
        baseUrl: doc.baseUrl,
      };
    }
    return {
      integrationId: doc._id,
      authType: 'apiKeyBaseUrl',
      credentials: { apiKey: this.decryptStoredApiKey(doc.apiKey) },
      baseUrl: doc.baseUrl,
    };
  }

  /** Every connected integration for this org, id + provider only — used by
   * DynamicExecutorService/capabilities discovery to enumerate without
   * decrypting credentials that aren't needed for a listing. */
  async listConnected(organizationId: string): Promise<{ integrationId: Types.ObjectId; provider: string }[]> {
    const docs = await this.credentialModel.find({ organizationId }, { provider: 1 });
    return docs.map((doc) => ({ integrationId: doc._id, provider: doc.provider }));
  }

  private friendlyErrorMessage(err: unknown): string {
    const axiosErr = err as { response?: { status?: number }; code?: string };
    const status = axiosErr.response?.status;
    if (status === 401) return 'The provider rejected these credentials (401 Unauthorized).';
    if (status === 403) return "These credentials don't have permission to access this resource (403 Forbidden).";
    if (status === 404) return 'Reached the server, but that URL/endpoint was not found (404).';
    if (status && status >= 500) return `The provider's server had an error (HTTP ${status}).`;
    if (axiosErr.code === 'ECONNABORTED') return 'The connection timed out — check the base URL.';
    if (axiosErr.code === 'ENOTFOUND' || axiosErr.code === 'ECONNREFUSED') {
      return "Couldn't reach that URL — check it's correct and publicly reachable.";
    }
    return 'Could not connect — please check the URL and credentials.';
  }

  getProviderRule(provider: string): ProviderRule {
    return getProviderRule(provider);
  }

  /** Server-side enforcement of provider-rules.ts — the frontend filters
   * the auth-method dropdown using the same table (GET
   * /integrations/provider-rules/:provider) so a user normally never gets
   * this far with a disallowed combination, but this is the actual security
   * boundary: "never fake or bypass authentication requirements" has to
   * hold even against a direct API call, not just the UI. */
  private assertAllowed(provider: string, authType?: AuthType): void {
    if (!PROVIDER_SLUG.test(provider)) {
      throw new BadRequestException('Provider name must be alphanumeric (dashes/underscores allowed).');
    }
    const rule = getProviderRule(provider);
    if (rule.dedicatedFlowPath) {
      throw new BadRequestException(rule.note ?? `"${provider}" has its own dedicated connect flow.`);
    }
    if (authType && !rule.allowedAuthTypes.includes(authType)) {
      throw new BadRequestException(rule.note ?? `${rule.label} only supports: ${rule.allowedAuthTypes.join(', ') || 'a dedicated flow not yet built here'}.`);
    }
  }

  private mask(apiKey: string): string {
    return apiKey.length > 12 ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '***';
  }

  /** `apiKey` used to be stored plaintext; every row written by connect()
   * from now on is AES-256-GCM encrypted (see EncryptionService). Decrypts
   * transparently, but falls back to the raw value when decryption fails —
   * GCM's auth tag makes that fallback only ever trigger on a genuinely
   * pre-existing plaintext row, never silently accept tampered ciphertext as
   * "must be legacy plaintext". No migration script needed: every row
   * upgrades to encrypted the next time its owner reconnects/saves it. */
  private decryptStoredApiKey(value: string | undefined): string {
    if (!value) return '';
    try {
      return this.encryption.decrypt(value);
    } catch {
      return value;
    }
  }
}
