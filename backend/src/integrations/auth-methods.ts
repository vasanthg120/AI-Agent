// The universal-connector piece: every non-OAuth auth style a "connect any
// REST API" flow actually needs, in one small builder. Most OAuth-based
// platforms (HubSpot, Slack, ...) each need their own dedicated consent flow
// and app registration — see outlook/gmail/auth/oauth.service.ts for that
// shape — and aren't handled here; this is deliberately the subset that
// needs no per-provider app registration, callback route, or consent screen,
// so a customer can self-serve connect any REST API immediately.
//
// 'oauth2' is the one exception living here rather than its own schema: Zoho
// and Salesforce (see ../zoho/, ../salesforce/) DO have a real dedicated
// consent flow, but — unlike Outlook/Gmail's per-user mailbox connections —
// a CRM connection here is already one-per-organization, exactly what
// IntegrationCredential already models for every other CRM provider. So only
// the *token acquisition* (authorize/callback/refresh) is provider-specific;
// *storage* reuses this same credential row, with 'oauth2' behaving like
// 'bearer' for header-building purposes (see buildAuthHeaders below) plus
// two schema fields no other authType needs (refreshTokenEncrypted,
// tokenExpiresAt — see integration-credential.schema.ts).
export type AuthType = 'apiKey' | 'apiKeyBaseUrl' | 'bearer' | 'basic' | 'customHeaders' | 'oauth2';

export const AUTH_TYPES: AuthType[] = ['apiKey', 'apiKeyBaseUrl', 'bearer', 'basic', 'customHeaders', 'oauth2'];

// Superset of every field any AuthType might need — a given connection only
// ever populates the subset its authType actually uses (validated in
// integrations.service.ts before this ever gets called). Kept as one flat
// shape rather than a discriminated union so it round-trips through a single
// encrypted JSON blob (see IntegrationCredential.credentialsEncrypted)
// without a schema per auth type.
export interface AuthCredentials {
  apiKey?: string;
  bearerToken?: string;
  username?: string;
  password?: string;
  headerName?: string;
  headers?: Record<string, string>;
  // oauth2 only — the live access token. Never the refresh token: that one
  // deliberately never enters this blob (see refreshTokenEncrypted on the
  // schema) so a consumer that only needs to resolveAuth() for an outbound
  // call can never accidentally receive it.
  accessToken?: string;
}

export function requiredCredentialFields(authType: AuthType): (keyof AuthCredentials)[] {
  switch (authType) {
    case 'apiKey':
    case 'apiKeyBaseUrl':
      return ['apiKey'];
    case 'bearer':
      return ['bearerToken'];
    case 'basic':
      return ['username', 'password'];
    case 'customHeaders':
      return ['headers'];
    case 'oauth2':
      // The real flow (zoho.service.ts/salesforce.service.ts's callback)
      // always has one by construction. Listed as required mainly so the
      // generic connectWithAuth() path still rejects an empty submission if
      // anything ever posts authType=oauth2 through it directly (e.g. a
      // manually-pasted access token — no refresh, same limitation class as
      // today's "paste a Salesforce JWT as bearer" fallback).
      return ['accessToken'];
  }
}

/** Builds the HTTP headers a request to this provider needs. Mirrored
 * byte-for-byte in python-agent/app/memory/integration_store.py's
 * build_auth_headers — any change here needs the same change there. */
export function buildAuthHeaders(authType: AuthType, creds: AuthCredentials): Record<string, string> {
  switch (authType) {
    case 'apiKey':
    case 'apiKeyBaseUrl':
      // No universal standard header name for a bare API key across
      // arbitrary REST APIs (X-Api-Key, Api-Key, X-API-TOKEN all appear in
      // the wild) — headerName lets the customer specify theirs; falls back
      // to the most common convention if they don't.
      return { [creds.headerName || 'X-Api-Key']: creds.apiKey ?? '' };
    case 'bearer':
      return { Authorization: `Bearer ${creds.bearerToken ?? ''}` };
    case 'basic': {
      const encoded = Buffer.from(`${creds.username ?? ''}:${creds.password ?? ''}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    }
    case 'customHeaders':
      return creds.headers ?? {};
    case 'oauth2':
      // Zoho's own header scheme technically differs (`Zoho-oauthtoken
      // <token>` instead of `Bearer`), but DynamicExecutorService/this
      // generic path is never used for Zoho/Salesforce's own CRM sync calls
      // (crm_adapters.py builds its own provider-correct header) — this is
      // only reached for an admin-configured custom REST endpoint against
      // some *other* API using the same stored Zoho/Salesforce access token,
      // where plain Bearer is the correct default.
      return { Authorization: `Bearer ${creds.accessToken ?? ''}` };
  }
}
