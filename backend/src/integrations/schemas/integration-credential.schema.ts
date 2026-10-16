import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type IntegrationCredentialDocument = IntegrationCredential & Document<Types.ObjectId>;

@Schema({ timestamps: true, collection: 'integration_credentials' })
export class IntegrationCredential {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  provider: string;

  // Required historically (the only auth style that existed: apiKey +
  // optional baseUrl, used by the 'anthropic'/'crm' providers). Relaxed to
  // optional so newer auth types (bearer/basic/customHeaders — see
  // ../auth-methods.ts) that have no meaningful "apiKey" value can omit it;
  // every existing row already has one populated, so this is additive, not
  // a migration.
  @Prop()
  apiKey?: string;

  @Prop()
  baseUrl?: string;

  // Which shape `credentialsEncrypted` below is decrypted into — undefined
  // on every row written before this existed, which callers should treat as
  // the original apiKey(+baseUrl) style (see IntegrationsService.status).
  // 'oauth2' added for Zoho/Salesforce (see ../oauth/oauth-connections.service.ts)
  // — credentialsEncrypted holds {accessToken} for this type, same shape
  // buildAuthHeaders already treats like 'bearer'; the two fields below carry
  // what bearer/basic/etc never needed: a refresh token and an expiry.
  @Prop()
  authType?: 'apiKey' | 'apiKeyBaseUrl' | 'bearer' | 'basic' | 'customHeaders' | 'oauth2';

  // Encrypted (see common/encryption/encryption.service.ts) JSON blob of
  // AuthCredentials (../auth-methods.ts) — bearerToken/username+password/
  // custom headers, whichever authType above needs. The legacy `apiKey`
  // field above is plaintext and untouched for backward compatibility;
  // encryption only applies to auth data going through this newer path.
  @Prop()
  credentialsEncrypted?: string;

  // oauth2 only — encrypted the same way as credentialsEncrypted above (same
  // EncryptionService, separate field so a refresh can overwrite just this
  // without re-touching the access token blob, and so python-agent's sync
  // adapters can read/refresh without parsing the whole credentials JSON).
  // Absent for every non-oauth2 authType.
  @Prop()
  refreshTokenEncrypted?: string;

  // oauth2 only — when the current access token expires. Checked with a
  // buffer before use (see IntegrationsService.resolveAuth and python-agent's
  // app/integrations/oauth_refresh.py) and refreshed just-in-time, the same
  // lazy-on-read pattern outlook_store.py already uses for Outlook/Gmail.
  @Prop()
  tokenExpiresAt?: Date;

  // oauth2 only — provider-specific values the API domain/instance itself
  // depends on, learned from the token response (Zoho's `api_domain`,
  // Salesforce's `instance_url`) rather than assumed, since neither provider
  // puts every customer on the same host. Stored here instead of overloading
  // `baseUrl` so a refresh that returns a new value never has to guess
  // which other field it's allowed to touch.
  @Prop({ type: Object })
  oauthMeta?: Record<string, string>;

  // oauth2 only — mirrors OutlookConnection/GmailConnection's own
  // 'needs_reauth' status: set when a refresh attempt fails with an
  // unrecoverable error (revoked/expired refresh token), so sync and
  // DynamicExecutorService stop silently retrying a dead connection and the
  // CRM card can tell the customer to reconnect instead of showing a vague
  // sync failure. Absent (undefined) means connected — the default for
  // every non-oauth2 row, which has no concept of reauth.
  @Prop()
  status?: 'connected' | 'needs_reauth';

  // Zoho only (see ../zoho/zoho.service.ts's resolveAppCredentials) — the
  // organization's OWN Zoho API Console app, entered via Settings ->
  // Integrations' "Connect Zoho CRM" credential modal, instead of Haive's
  // shared platform app (ZOHO_CLIENT_ID/SECRET env vars). Not a secret
  // itself (Zoho client ids are visible in the authorize URL/browser
  // address bar anyway, same as Outlook/Google client ids) — stored
  // plaintext like baseUrl above, consistent with that.
  @Prop()
  oauthClientId?: string;

  // Zoho only — encrypted the same way as refreshTokenEncrypted above.
  // Populated by POST /zoho/app-credentials BEFORE any OAuth round trip
  // happens (there is no connection yet at that point — authType/
  // credentialsEncrypted/refreshTokenEncrypted stay unset until the
  // customer actually completes the Zoho consent screen). Read back by
  // buildAuthorizeUrl, the callback's token exchange, and every future
  // refresh (IntegrationsService.refreshOAuthToken / python-agent's
  // oauth_refresh.py), all of which must use the SAME client id/secret the
  // original authorization was issued under.
  @Prop()
  oauthClientSecretEncrypted?: string;

  // Optional path (e.g. "/health", "/ping") appended to baseUrl for the
  // Test Connection button — POST /integrations/:provider/test. Empty means
  // "just hit baseUrl itself".
  @Prop()
  healthCheckPath?: string;

  // Admin-configured spend budget for this credential (currently only set
  // for the 'anthropic' platform credential, from the AI Usage admin page).
  // This is Haive's own tracking target, NOT an authoritative balance from
  // the provider — the Anthropic API for a plain API key exposes no account
  // balance, so "remaining" is always budgetUsd minus Haive's own recorded
  // spend (see ai-usage-admin.service.ts), never claimed as provider truth.
  @Prop({ type: Number })
  budgetUsd?: number;

  @Prop({ enum: ['monthly', 'total'], default: 'monthly' })
  budgetPeriod?: 'monthly' | 'total';
}

export const IntegrationCredentialSchema = SchemaFactory.createForClass(IntegrationCredential);
// One credential per (org, provider) — was a single global doc per provider
// shared by the entire deployment, which meant every tenant's chat agent
// used the same Anthropic/CRM key. Compound-unique replaces the old
// field-level `unique: true` on `provider` alone.
IntegrationCredentialSchema.index({ organizationId: 1, provider: 1 }, { unique: true });
