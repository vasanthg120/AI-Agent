import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { EncryptionService } from '../common/encryption/encryption.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { GmailConnection, GmailConnectionDocument } from './schemas/gmail-connection.schema';

// Same fixed sentinel admin-integrations.controller.ts uses for the AI
// provider credentials (Anthropic/Sarvam/ElevenLabs/Groq) — one platform-
// wide Google OAuth app for every organization's Gmail mailboxes, configured
// only by a Haive platform admin (see that controller's gmail/app-credentials
// routes), never a per-organization app like Zoho's. Never client-supplied.
const PLATFORM_INTEGRATION_SCOPE = 'platform';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export interface GmailAccountSummary {
  email: string;
  isActive: boolean;
  connectedAt: Date;
  status: 'connected' | 'needs_reauth';
}

// gmail.send is requested now (not just gmail.readonly) so a future
// send-email tool/action doesn't need every existing connection to
// re-consent — no send action is built yet (Phase 8 plan notes: read-only
// this phase).
const GMAIL_SCOPES =
  'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email';

/**
 * Per-user delegated Gmail API auth — 1:1 the same OAuth shape as
 * OutlookService (connect-url -> signed-JWT state -> provider authorize URL
 * -> callback -> code exchange -> upsert connection doc), just against
 * Google's endpoints/scopes instead of Microsoft's. A user can connect
 * several mailboxes; exactly one is "active" at a time — that's the one
 * python-agent reads/refreshes (see app/memory/gmail_store.py).
 */
@Injectable()
export class GmailService {
  constructor(
    private config: ConfigService,
    private http: HttpService,
    private encryption: EncryptionService,
    private integrations: IntegrationsService,
    @InjectModel(GmailConnection.name) private connectionModel: Model<GmailConnectionDocument>,
  ) {}

  /** The platform's Google OAuth app — saved via a Haive platform admin
   * (POST /integrations/admin/gmail/app-credentials, see
   * admin-integrations.controller.ts), falling back to GOOGLE_CLIENT_ID/
   * GOOGLE_CLIENT_SECRET env vars only for a deployment that configured
   * those before this existed (backward compatible: an org's already-issued
   * refresh tokens were minted against whichever app was active at the
   * time, so this must keep resolving the SAME one on every call, not
   * silently prefer the DB once both happen to be present — env vars are
   * the fallback, DB is the preferred/no-longer-required path, exactly the
   * precedence the admin UI documents). Throws a clear, user-facing error
   * (never an empty client_id reaching Google) when neither is configured. */
  private async resolveAppCredentials(): Promise<{ clientId: string; clientSecret: string }> {
    const saved = await this.integrations.resolveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'gmail');
    if (saved) return saved;

    const envClientId = this.config.get<string>('integrations.google.clientId');
    const envClientSecret = this.config.get<string>('integrations.google.clientSecret');
    if (!envClientId || !envClientSecret) {
      throw new BadRequestException({
        code: 'GMAIL_APP_CREDENTIALS_REQUIRED',
        message: 'Gmail is not available yet — ask your Haive administrator to configure Google OAuth.',
      });
    }
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  /** Read-only, customer-facing "is Gmail available at all" check (GET
   * /gmail/app-status) — deliberately returns nothing but a boolean. An
   * ordinary customer user has no reason to see the platform's Google
   * Client ID (let alone the secret), unlike Zoho's status endpoint, which
   * shows the organization's OWN app details because they own it. */
  async isAppConfigured(): Promise<boolean> {
    try {
      await this.resolveRuntimeConfig();
      return true;
    } catch {
      return false;
    }
  }

  /** The callback URL Google redirects back to — resolved from runtime
   * config only (configuration.ts's resolveGmailRedirectUri: an explicit
   * GOOGLE_REDIRECT_URI, or this backend's own public base URL +
   * /gmail/callback). Never defaults to localhost here: an unset or
   * malformed value throws a clear config error instead of silently
   * reaching Google with a wrong redirect_uri (which would otherwise fail
   * much more confusingly, as Google's own "redirect_uri_mismatch"). */
  private resolveCallbackUrl(): string {
    const configured = (this.config.get<string>('integrations.google.redirectUri') ?? '').trim();
    if (!configured) {
      throw new BadRequestException({
        code: 'GMAIL_CALLBACK_URL_REQUIRED',
        message: 'Gmail is not available yet — ask your Haive administrator to configure the Gmail OAuth callback URL (GOOGLE_REDIRECT_URI).',
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new BadRequestException({
        code: 'GMAIL_CALLBACK_URL_INVALID',
        message: 'Gmail is not available — the configured OAuth callback URL is not a valid URL. Ask your Haive administrator to fix GOOGLE_REDIRECT_URI.',
      });
    }
    if (this.config.get<string>('nodeEnv') === 'production' && parsed.protocol !== 'https:') {
      throw new BadRequestException({
        code: 'GMAIL_CALLBACK_URL_INVALID',
        message: 'Gmail is not available — the configured OAuth callback URL must use https in production.',
      });
    }
    return configured;
  }

  /** Single resolution point for both buildAuthorizeUrl and exchangeCode —
   * guarantees they can never diverge (Google rejects a token exchange whose
   * redirect_uri doesn't exactly match the one used for the original
   * authorize request). */
  private async resolveRuntimeConfig(): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
    const app = await this.resolveAppCredentials();
    const redirectUri = this.resolveCallbackUrl();
    return { ...app, redirectUri };
  }

  async buildAuthorizeUrl(state: string): Promise<string> {
    const app = await this.resolveRuntimeConfig();

    const params = new URLSearchParams({
      client_id: app.clientId,
      response_type: 'code',
      redirect_uri: app.redirectUri,
      scope: GMAIL_SCOPES,
      // access_type=offline + prompt=consent are what makes Google actually
      // return a refresh_token — unlike Microsoft, Google only issues one
      // on the very first consent unless prompt=consent forces the screen
      // again, so this is required, not just a UX nicety like Outlook's
      // "select_account".
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleCallback(code: string, userId: string): Promise<{ email: string }> {
    const tokens = await this.exchangeCode(code);
    const email = await this.fetchUserEmail(tokens.access_token);

    // Newly connected/reconnected account becomes the active one; every
    // other account for this user is demoted (but stays connected).
    await this.connectionModel.updateMany({ userId }, { isActive: false });
    await this.connectionModel.findOneAndUpdate(
      { userId, email },
      {
        userId,
        email,
        // Encrypted at rest (see common/encryption/encryption.service.ts).
        // A fresh reconnect through this same callback is also how a
        // needs_reauth row recovers — this upsert overwrites status back to
        // the schema default ('connected') along with the new tokens.
        accessToken: this.encryption.encrypt(tokens.access_token),
        refreshToken: this.encryption.encrypt(tokens.refresh_token),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scope: tokens.scope,
        isActive: true,
        status: 'connected',
      },
      { upsert: true },
    );
    return { email };
  }

  async getStatus(userId: string): Promise<{ connected: boolean; email?: string; needsReauth?: boolean }> {
    const active = await this.connectionModel.findOne({ userId, isActive: true }).select({ email: 1, status: 1 });
    return {
      connected: Boolean(active) && active?.status !== 'needs_reauth',
      email: active?.email,
      needsReauth: active?.status === 'needs_reauth',
    };
  }

  async listAccounts(userId: string): Promise<GmailAccountSummary[]> {
    const connections = await this.connectionModel
      .find({ userId })
      .select({ email: 1, isActive: 1, createdAt: 1, status: 1 })
      .sort({ createdAt: -1 });
    return connections.map((c) => ({
      email: c.email,
      isActive: c.isActive,
      connectedAt: (c as unknown as { createdAt: Date }).createdAt,
      status: c.status ?? 'connected',
    }));
  }

  async setActive(userId: string, email: string): Promise<void> {
    const target = await this.connectionModel.findOne({ userId, email });
    if (!target) throw new NotFoundException(`No connected Gmail account for ${email}`);
    await this.connectionModel.updateMany({ userId }, { isActive: false });
    await this.connectionModel.updateOne({ userId, email }, { isActive: true });
  }

  async disconnect(userId: string, email: string): Promise<void> {
    const wasActive = await this.connectionModel.findOne({ userId, email }).select({ isActive: 1 });
    await this.connectionModel.deleteOne({ userId, email });
    if (wasActive?.isActive) {
      // Promote the most recently connected remaining account, if any.
      const next = await this.connectionModel.findOne({ userId }).sort({ createdAt: -1 });
      if (next) await this.connectionModel.updateOne({ _id: next._id }, { isActive: true });
    }
  }

  private tokenEndpoint(): string {
    return 'https://oauth2.googleapis.com/token';
  }

  private async exchangeCode(code: string): Promise<TokenResponse> {
    // Must be the SAME client id/secret/redirect_uri buildAuthorizeUrl used
    // for this authorize request — Google rejects a code exchange whose
    // client_id or redirect_uri doesn't match the one the user actually
    // consented to. Both come from the same resolveRuntimeConfig() call
    // buildAuthorizeUrl used, so they can never drift apart.
    const app = await this.resolveRuntimeConfig();

    const body = new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
    });

    const response = await firstValueFrom(
      this.http.post<TokenResponse>(this.tokenEndpoint(), body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    return response.data;
  }

  private async fetchUserEmail(accessToken: string): Promise<string> {
    const response = await firstValueFrom(
      this.http.get<{ email: string }>('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return response.data.email;
  }
}
