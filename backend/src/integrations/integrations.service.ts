import { HttpService } from '@nestjs/axios';
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
import {
  IntegrationCredential,
  IntegrationCredentialDocument,
} from './schemas/integration-credential.schema';

// The two provider slugs a connected CRM is ever stored under (the fixed
// 'crm' card's legacy apiKey path, or the generic Custom Integration flow
// using the external CRM's own connector id) — see prospectconnect.py's
// resolve_credentials for why both are checked everywhere else too.
const CRM_PROVIDERS = new Set(['crm', 'prospectconnect']);

const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

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
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  /** The actual sync call, awaited — used both by the fire-and-forget
   * post-connect trigger below and by the explicit "Sync Now" endpoint
   * (POST /integrations/crm/sync), which needs a real result to show the
   * user rather than firing blind. Throws on failure (e.g. python-agent
   * unreachable) so callers can decide how to surface that. */
  async syncCrmNow(organizationId: string): Promise<{ dealsSynced: number; quotesSynced: number }> {
    const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '5m' });
    const { data } = await firstValueFrom(
      this.http.post<{ dealsSynced: number; quotesSynced: number }>(
        `${this.pythonAgentUrl}/sync/crm/run-for-org`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
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
   * service.ts's post-save Qdrant sync call. Scoped to 'crm'/'prospectconnect'
   * only; every other provider (Anthropic, Stripe, a customer's own custom
   * REST API, ...) has nothing to sync. */
  private triggerCrmSyncIfApplicable(organizationId: string, provider: string): void {
    if (!CRM_PROVIDERS.has(provider)) return;
    this.syncCrmNow(organizationId).catch((err) => {
      this.logger.error(`Immediate CRM sync failed for org ${organizationId}: ${(err as Error).message}`);
    });
  }

  /** Legacy shape, request/response byte-for-byte unchanged: apiKey (+
   * optional baseUrl), used by the 'anthropic' and 'crm' connect UI today.
   * The stored value is now encrypted at rest (was plaintext) — every read
   * site goes through decryptStoredApiKey() below, which also transparently
   * upgrades any row still holding an old plaintext value. */
  async connect(
    organizationId: string,
    provider: string,
    apiKey: string,
    baseUrl?: string,
  ): Promise<{ connected: true; maskedKey: string; baseUrl?: string }> {
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
    this.triggerCrmSyncIfApplicable(organizationId, provider);
    return { connected: true, authType, baseUrl: dto.baseUrl };
  }

  /** Routes to connect() or connectWithAuth() above based on whether the
   * request set authType — the single HTTP entry point (see
   * IntegrationsController), kept as one endpoint so the API surface
   * doesn't fork in two. */
  connectFromDto(organizationId: string, provider: string, dto: ConnectIntegrationDto) {
    if (dto.authType) return this.connectWithAuth(organizationId, provider, dto);
    return this.connect(organizationId, provider, dto.apiKey!, dto.baseUrl);
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
    const docs = await this.credentialModel
      .find({ organizationId, provider: { $nin: ['anthropic', 'crm'] } })
      .sort({ createdAt: -1 });
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
  }

  /** Pings the provider's baseUrl (+ optional healthCheckPath) with the
   * saved (or just-entered, pre-save) credentials' auth headers applied.
   * Never throws — every failure mode (DNS, timeout, 401/403, 5xx) is
   * translated into a friendly {ok:false, message} instead of a raw HTTP/
   * network error, per the "never expose raw errors" requirement. */
  async testConnection(
    organizationId: string,
    provider: string,
    dto: TestConnectionDto,
  ): Promise<{ ok: boolean; message: string }> {
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
    if (status === 403) return 'These credentials don\'t have permission to access this resource (403 Forbidden).';
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
      throw new BadRequestException(
        rule.note ??
          `${rule.label} only supports: ${rule.allowedAuthTypes.join(', ') || 'a dedicated flow not yet built here'}.`,
      );
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
