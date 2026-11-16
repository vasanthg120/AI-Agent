import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { IntegrationsService } from '../integrations/integrations.service';

// Pinned, not "latest" — confirmed live against Square's own API reference
// (never guessed): an unpinned version would silently pick up Square's
// newest breaking changes on every call. Bump deliberately, not implicitly.
const SQUARE_API_VERSION = '2026-09-16';

// Confirmed live against Square's international-capabilities docs/forums
// (not assumed) — Square only processes LIVE payments in these 8 seller
// countries; Sandbox seller accounts only exist for the same 8. An
// organization anywhere else can still connect (the token itself isn't
// country-gated), but every payment attempt would fail at Square's end —
// so this is checked right after connecting and surfaced honestly (see
// connect() below), never silently allowed through.
export const SQUARE_SUPPORTED_SELLER_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'JP', 'IE', 'FR', 'ES'] as const;

// Stored in refreshTokenEncrypted's slot purely because connectWithOAuth's
// storage shape requires SOME value there — never a real refresh token (see
// this file's own module comment on why there's no refresh flow at all for
// this token type). If the private refreshOAuthToken() branch for 'square'
// in IntegrationsService were ever somehow reached for a row created this
// way, Square would reject this value and the connection would fail closed
// into needs_reauth — never silently "succeed" with a fabricated refresh.
const NO_REFRESH_SENTINEL = 'PERSONAL_ACCESS_TOKEN_HAS_NO_REFRESH_TOKEN';

// Square's docs confirm personal access tokens (the ones this module uses —
// see the class comment) never expire; this schema still wants a concrete
// Date, so a comfortably-far sentinel stands in for "doesn't expire" rather
// than pretending there's a real, meaningful expiry.
const EFFECTIVELY_NEVER_EXPIRES_SECONDS = 10 * 365 * 24 * 60 * 60;

interface SquareMerchant {
  id: string;
  business_name?: string;
  country: string;
  currency: string;
  status?: string;
}

interface SquareTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
  errors?: { detail?: string }[];
}

interface SquareOAuthState {
  organizationId: string;
  purpose: 'square-oauth';
  // Carried in the signed state itself, never as a redirect_uri query param
  // — Square requires the redirect_uri to exactly match what's registered
  // in the org's Square Developer Console app (confirmed live: even a
  // trailing-slash mismatch fails), so it can't carry extra query params
  // the way an ordinary redirect could.
  environment: 'sandbox' | 'production';
}

interface SquareAppCredentials {
  clientId: string;
  clientSecret: string;
  webhookNotificationUrl?: string;
}

export interface SquareConnectionStatus {
  connected: boolean;
  environment?: 'sandbox' | 'production';
  applicationId?: string;
  merchantId?: string;
  businessName?: string;
  country?: string;
  currency?: string;
  countrySupported?: boolean;
  needsReauth?: boolean;
}

export interface CreateSquarePaymentInput {
  sourceId: string;
  amount: number;
  currency: string;
  idempotencyKey?: string;
  customerId?: string;
  orderId?: string;
  referenceId?: string;
  note?: string;
}

/**
 * Square Payments connection — one per ORGANIZATION, stored through
 * IntegrationsService.connectWithOAuth for its storage shape (encrypted
 * token + arbitrary oauthMeta for merchant info).
 *
 * Two deliberately separate connect paths, both confirmed live against
 * Square's own docs, matching the two cases the user asked for directly:
 *
 * - **Personal Access Token** (`connect()` below) — for an organization
 *   connecting its OWN Square account. Each Square Developer Console app
 *   exposes a production personal access token and a separate Sandbox
 *   access token directly in its dashboard
 *   (developer.squareup.com/docs/build-basics/access-tokens), scoped to the
 *   account owner's own account with every permission that account has,
 *   and — unlike an OAuth access token — it never expires. Square's own
 *   docs are explicit this token type is for an app's own account, not a
 *   third party acting on behalf of independent sellers. No app
 *   registration, no redirect, no refresh token (see NO_REFRESH_SENTINEL).
 * - **OAuth 2.0** (`buildAuthorizeUrl`/`handleCallback` below) — for
 *   connecting a DIFFERENT Square merchant account ("multiple Square
 *   customer accounts"), using this organization's OWN Square Developer
 *   app (`saveAppCredentials`/`resolveAppCredentials`) — the exact same
 *   per-organization "bring your own OAuth app" shape Zoho CRM already uses
 *   in this codebase (zoho.service.ts), not a Haive-wide platform app:
 *   there's no sense in which Square here is Haive's own billing gateway,
 *   only ever each org's own merchant relationship.
 *
 * Both paths converge on the same storage shape, so getStatus/disconnect/
 * createPayment/listPayments/getPayment work unchanged regardless of which
 * one produced the stored token.
 *
 * Phase A scope (see the approved plan): both connect paths, status/
 * disconnect lifecycle, country/currency validation against Square's own
 * Merchants API (never against Haive's own free-text org address — no
 * reliable ISO country field exists there), and payment creation/
 * retrieval/history. Refunds, customer/order/catalog/inventory/payout/
 * invoice sync, webhooks, and AI tools are later phases.
 */
@Injectable()
export class SquareService {
  constructor(
    private config: ConfigService,
    private http: HttpService,
    private jwt: JwtService,
    private integrations: IntegrationsService,
  ) {}

  private apiBaseUrl(environment: 'sandbox' | 'production'): string {
    return environment === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  }

  /** Saves THIS organization's own Square Developer Console app (Application
   * ID/Secret) — needed only for the OAuth path (see buildAuthorizeUrl/
   * handleCallback below), never for the Personal Access Token path
   * (connect() above). Per-organization, same "bring your own app" shape as
   * Zoho CRM's saveAppCredentials (zoho.service.ts) — there is no
   * Haive-wide Square app, unlike Xero/MYOB/Gmail's platform-wide ones,
   * because Square here is never Haive's own billing gateway, only each
   * org's own merchant connection.
   *
   * webhookSecret is optional: a webhook subscription (and its signature
   * key) only exists in Square's Developer Console once an app already
   * does, so this is routinely blank on the first save and filled in
   * afterward via this same endpoint. */
  async saveAppCredentials(organizationId: string, clientId: string, clientSecret: string, webhookSecret?: string, webhookNotificationUrl?: string): Promise<{ configured: true }> {
    // Merges with whatever meta an already-completed connection set
    // (environment/merchantId/country/...) — saveOAuthAppCredentials
    // replaces the ENTIRE oauthMeta field when given one, so saving the
    // webhook URL on its own would otherwise silently wipe out an
    // already-working connection's own data.
    const existing = await this.integrations.resolveOAuthAppCredentials(organizationId, 'square');
    await this.integrations.saveOAuthAppCredentials(organizationId, 'square', {
      clientId,
      clientSecret,
      webhookSecret,
      ...(webhookNotificationUrl ? { meta: { ...existing?.meta, webhookNotificationUrl } } : {}),
    });
    return { configured: true };
  }

  async getAppCredentialsStatus(organizationId: string): Promise<{ configured: boolean; clientId?: string; webhookSecretConfigured?: boolean }> {
    const status = await this.integrations.getOAuthAppCredentialsStatus(organizationId, 'square');
    return { configured: status.configured, clientId: status.clientId, webhookSecretConfigured: status.webhookSecretConfigured };
  }

  private async resolveAppCredentials(organizationId: string): Promise<SquareAppCredentials> {
    const saved = await this.integrations.resolveOAuthAppCredentials(organizationId, 'square');
    if (!saved) {
      throw new BadRequestException({
        code: 'SQUARE_APP_CREDENTIALS_REQUIRED',
        message: 'Save your Square Application ID and Application Secret first, then connect.',
      });
    }
    return { clientId: saved.clientId, clientSecret: saved.clientSecret, webhookNotificationUrl: saved.meta?.webhookNotificationUrl };
  }

  /** OAuth path — for connecting a Square merchant account that ISN'T this
   * organization's own (see this file's class comment: "multiple Square
   * customer accounts"). Requires this org's own app (saveAppCredentials
   * above) since Square's OAuth has no concept of a Haive-wide app here.
   * Mechanics mirror zoho.service.ts's buildAuthorizeUrl exactly (signed-JWT
   * state, 10m expiry) — scopes are the same Phase A set connect() implies
   * (MERCHANT_PROFILE_READ + PAYMENTS_READ/WRITE); refund/customer scopes
   * are added only once the code that uses them exists. */
  async buildAuthorizeUrl(organizationId: string, environment: 'sandbox' | 'production'): Promise<string> {
    const app = await this.resolveAppCredentials(organizationId);
    const redirectUri = this.config.get<string>('integrations.square.redirectUri') ?? '';
    const state = this.jwt.sign({ organizationId, purpose: 'square-oauth', environment } satisfies SquareOAuthState, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: app.clientId,
      scope: 'MERCHANT_PROFILE_READ PAYMENTS_READ PAYMENTS_WRITE',
      session: 'false',
      state,
      redirect_uri: redirectUri,
    });
    return `${this.apiBaseUrl(environment)}/oauth2/authorize?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<SquareConnectionStatus> {
    let payload: SquareOAuthState;
    try {
      payload = this.jwt.verify<SquareOAuthState>(state);
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (payload.purpose !== 'square-oauth' || !payload.organizationId) {
      throw new UnauthorizedException('Invalid state');
    }
    const organizationId = payload.organizationId;
    const environment = payload.environment;

    const app = await this.resolveAppCredentials(organizationId);
    const tokens = await this.exchangeCode(code, app, environment);
    const merchant = await this.fetchMerchant(tokens.access_token!, environment);
    const countrySupported = (SQUARE_SUPPORTED_SELLER_COUNTRIES as readonly string[]).includes(merchant.country);

    const expiresInSeconds = tokens.expires_at ? Math.max(60, (new Date(tokens.expires_at).getTime() - Date.now()) / 1000) : 2_592_000;
    await this.integrations.connectWithOAuth(
      organizationId,
      'square',
      {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresInSeconds,
        // Merges in app.webhookNotificationUrl (if saved) explicitly —
        // connectWithOAuth replaces the ENTIRE oauthMeta field, it never
        // deep-merges, so a value saved earlier via saveAppCredentials
        // would otherwise be silently wiped out by this very call.
        oauthMeta: {
          environment,
          merchantId: merchant.id,
          businessName: merchant.business_name ?? '',
          country: merchant.country,
          currency: merchant.currency,
          countrySupported: String(countrySupported),
          ...(app.webhookNotificationUrl ? { webhookNotificationUrl: app.webhookNotificationUrl } : {}),
        },
      },
      { skipSync: true },
    );

    return {
      connected: true,
      environment,
      merchantId: merchant.id,
      businessName: merchant.business_name,
      country: merchant.country,
      currency: merchant.currency,
      countrySupported,
    };
  }

  private async exchangeCode(code: string, app: SquareAppCredentials, environment: 'sandbox' | 'production'): Promise<SquareTokenResponse> {
    const redirectUri = this.config.get<string>('integrations.square.redirectUri') ?? '';
    const { data } = await firstValueFrom(
      this.http.post<SquareTokenResponse>(
        `${this.apiBaseUrl(environment)}/oauth2/token`,
        { grant_type: 'authorization_code', code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri },
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    if (!data.access_token || !data.refresh_token) {
      throw new Error(data.errors?.[0]?.detail ?? 'Square did not return an access/refresh token pair.');
    }
    return data;
  }

  /** Validates the pasted token by actually calling Square (never trusts a
   * token is real just because it's the right shape), fetches the merchant
   * profile it belongs to, and stores the connection. Using the WRONG
   * token for the chosen environment is a real, documented Square failure
   * mode (confirmed live) — surfaced here as a clear, specific error rather
   * than a generic "connection failed".
   *
   * applicationId is stored for identification only (per Square's own docs:
   * a personal access token authenticates the request entirely on its own —
   * the Application ID is never sent as part of any Payments/Merchants API
   * call here) — never treated as a secret, and never required by Square to
   * actually make a call. */
  async connect(organizationId: string, applicationId: string, accessToken: string, environment: 'sandbox' | 'production'): Promise<SquareConnectionStatus> {
    const merchant = await this.fetchMerchant(accessToken, environment);
    const countrySupported = (SQUARE_SUPPORTED_SELLER_COUNTRIES as readonly string[]).includes(merchant.country);

    await this.integrations.connectWithOAuth(
      organizationId,
      'square',
      {
        accessToken,
        refreshToken: NO_REFRESH_SENTINEL,
        expiresInSeconds: EFFECTIVELY_NEVER_EXPIRES_SECONDS,
        oauthMeta: {
          environment,
          applicationId,
          merchantId: merchant.id,
          businessName: merchant.business_name ?? '',
          country: merchant.country,
          currency: merchant.currency,
          countrySupported: String(countrySupported),
        },
      },
      { skipSync: true },
    );

    return {
      connected: true,
      environment,
      applicationId,
      merchantId: merchant.id,
      businessName: merchant.business_name,
      country: merchant.country,
      currency: merchant.currency,
      countrySupported,
    };
  }

  /** Validates credentials WITHOUT saving anything — a safe, read-only
   * Square call (ListLocations, confirmed live against Square's own
   * reference) the user can run before committing to Connect. Deliberately
   * separate from connect() above: this never touches IntegrationsService
   * at all, so a failed or exploratory test can never leave a half-written
   * connection behind. */
  async testConnection(accessToken: string, environment: 'sandbox' | 'production'): Promise<{ ok: boolean; message: string }> {
    try {
      const { data } = await firstValueFrom(
        this.http.get<{ locations?: { id: string; name?: string; status?: string }[]; errors?: { detail?: string }[] }>(`${this.apiBaseUrl(environment)}/v2/locations`, {
          headers: this.squareHeaders(accessToken),
        }),
      );
      const count = data.locations?.length ?? 0;
      return { ok: true, message: count > 0 ? `Connected — found ${count} location${count === 1 ? '' : 's'}.` : 'Connected, but this account has no locations yet.' };
    } catch (err) {
      const axiosErr = err as { response?: { status?: number; data?: { errors?: { detail?: string }[] } } };
      if (axiosErr.response?.status === 401) {
        return { ok: false, message: `That access token was rejected by Square (401) — check it's a real ${environment} token and matches the environment selected.` };
      }
      if (axiosErr.response) {
        return { ok: false, message: axiosErr.response.data?.errors?.[0]?.detail ?? `Square rejected the request (HTTP ${axiosErr.response.status}).` };
      }
      return { ok: false, message: 'Could not reach Square — check your connection and try again.' };
    }
  }

  async getStatus(organizationId: string): Promise<SquareConnectionStatus> {
    const auth = await this.integrations.resolveAuth(organizationId, 'square');
    if (!auth) return { connected: false };
    return {
      connected: true,
      environment: auth.oauthMeta?.environment as 'sandbox' | 'production' | undefined,
      applicationId: auth.oauthMeta?.applicationId,
      merchantId: auth.oauthMeta?.merchantId,
      businessName: auth.oauthMeta?.businessName,
      country: auth.oauthMeta?.country,
      currency: auth.oauthMeta?.currency,
      countrySupported: auth.oauthMeta?.countrySupported === 'true',
      needsReauth: !auth.credentials.accessToken,
    };
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.integrations.disconnect(organizationId, 'square');
  }

  private async resolveOrgAuth(organizationId: string): Promise<{ accessToken: string; environment: 'sandbox' | 'production'; locationId?: string }> {
    const auth = await this.integrations.resolveAuth(organizationId, 'square');
    if (!auth || !auth.credentials.accessToken) {
      throw new BadRequestException('Square isn’t connected for this organization.');
    }
    return {
      accessToken: auth.credentials.accessToken,
      environment: (auth.oauthMeta?.environment as 'sandbox' | 'production') || 'sandbox',
      locationId: auth.oauthMeta?.locationId,
    };
  }

  async createPayment(organizationId: string, input: CreateSquarePaymentInput): Promise<Record<string, unknown>> {
    const { accessToken, environment } = await this.resolveOrgAuth(organizationId);
    const body = {
      source_id: input.sourceId,
      // Never silently reuse a caller-omitted key — a missing idempotency
      // key is exactly the "duplicate payment" risk the spec calls out, so
      // one is always generated server-side rather than defaulted to
      // something predictable/reusable.
      idempotency_key: input.idempotencyKey ?? randomUUID(),
      amount_money: { amount: input.amount, currency: input.currency },
      ...(input.customerId ? { customer_id: input.customerId } : {}),
      ...(input.orderId ? { order_id: input.orderId } : {}),
      ...(input.referenceId ? { reference_id: input.referenceId } : {}),
      ...(input.note ? { note: input.note } : {}),
    };
    const { data } = await firstValueFrom(
      this.http.post<{ payment?: Record<string, unknown>; errors?: { detail?: string }[] }>(`${this.apiBaseUrl(environment)}/v2/payments`, body, {
        headers: this.squareHeaders(accessToken),
      }),
    );
    if (!data.payment) throw new BadRequestException(data.errors?.[0]?.detail ?? 'Square rejected the payment request.');
    return data.payment;
  }

  async getPayment(organizationId: string, paymentId: string): Promise<Record<string, unknown>> {
    const { accessToken, environment } = await this.resolveOrgAuth(organizationId);
    const { data } = await firstValueFrom(
      this.http.get<{ payment?: Record<string, unknown> }>(`${this.apiBaseUrl(environment)}/v2/payments/${encodeURIComponent(paymentId)}`, {
        headers: this.squareHeaders(accessToken),
      }),
    );
    if (!data.payment) throw new BadRequestException('Payment not found.');
    return data.payment;
  }

  async listPayments(
    organizationId: string,
    filters: { beginTime?: string; endTime?: string; customerId?: string; cursor?: string } = {},
  ): Promise<{ payments: Record<string, unknown>[]; cursor?: string }> {
    const { accessToken, environment, locationId } = await this.resolveOrgAuth(organizationId);
    const params: Record<string, string> = {};
    if (filters.beginTime) params.begin_time = filters.beginTime;
    if (filters.endTime) params.end_time = filters.endTime;
    if (filters.customerId) params.customer_id = filters.customerId;
    if (filters.cursor) params.cursor = filters.cursor;
    if (locationId) params.location_id = locationId;
    const { data } = await firstValueFrom(
      this.http.get<{ payments?: Record<string, unknown>[]; cursor?: string }>(`${this.apiBaseUrl(environment)}/v2/payments`, {
        headers: this.squareHeaders(accessToken),
        params,
      }),
    );
    return { payments: data.payments ?? [], cursor: data.cursor };
  }

  private squareHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_API_VERSION,
    };
  }

  // 'me' resolves to whichever merchant the token itself belongs to —
  // exactly right for a personal access token, which is always scoped to
  // its own account's single merchant and never needs a merchant id passed
  // in up front (confirmed live against Square's RetrieveMerchant reference).
  private async fetchMerchant(accessToken: string, environment: 'sandbox' | 'production'): Promise<SquareMerchant> {
    try {
      const { data } = await firstValueFrom(
        this.http.get<{ merchant?: SquareMerchant }>(`${this.apiBaseUrl(environment)}/v2/merchants/me`, {
          headers: this.squareHeaders(accessToken),
        }),
      );
      if (!data.merchant) throw new BadRequestException('Square accepted the request but returned no merchant profile.');
      return data.merchant;
    } catch (err) {
      const axiosErr = err as { response?: { status?: number; data?: { errors?: { detail?: string }[] } } };
      if (axiosErr.response) {
        const detail = axiosErr.response.data?.errors?.[0]?.detail;
        if (axiosErr.response.status === 401) {
          throw new BadRequestException(`That access token was rejected by Square (401) — check it's a real ${environment} token and matches the environment selected.`);
        }
        throw new BadRequestException(detail ?? `Square rejected the request (HTTP ${axiosErr.response.status}).`);
      }
      throw err;
    }
  }
}
