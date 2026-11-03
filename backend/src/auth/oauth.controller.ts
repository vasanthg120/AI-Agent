import { BadRequestException, Controller, Get, Logger, Param, Query, Redirect, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { OAuthProviderName, OAuthService } from './oauth.service';
import { PermissionExempt } from '../common/permissions/permission.decorator';

const PROVIDERS: OAuthProviderName[] = ['google', 'microsoft', 'github'];

function assertProvider(provider: string): asserts provider is OAuthProviderName {
  if (!PROVIDERS.includes(provider as OAuthProviderName)) {
    throw new BadRequestException(`Unknown OAuth provider: ${provider}`);
  }
}

// Deliberately unguarded (no JwtAuthGuard) — unlike gmail/outlook's
// connect-url, there is no logged-in user yet; `state` here only needs to
// prove the callback round-tripped through us (CSRF), not carry a user id.
@PermissionExempt('public')
@Controller('auth/oauth')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    private oauthService: OAuthService,
    private authService: AuthService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  @Get(':provider/url')
  getAuthorizeUrl(@Param('provider') provider: string) {
    assertProvider(provider);
    const state = this.jwtService.sign({ purpose: 'oauth-login', provider }, { expiresIn: '10m' });
    return { url: this.oauthService.buildAuthorizeUrl(provider, state) };
  }

  @Get(':provider/callback')
  @Redirect()
  async callback(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    try {
      assertProvider(provider);
      if (error || !code || !state) {
        this.logger.warn(`${provider} OAuth callback missing params (error=${error})`);
        return { url: `${frontendUrl}/login?oauth=error`, statusCode: 302 };
      }

      const payload = this.jwtService.verify<{ purpose: string; provider: string }>(state);
      if (payload.purpose !== 'oauth-login' || payload.provider !== provider) {
        throw new Error('OAuth state/provider mismatch');
      }

      const profile = await this.oauthService.exchangeCodeForProfile(provider, code);
      const result = await this.authService.loginWithOAuth(provider, profile, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      // Handing the token off via a query param redirect is the only option
      // for a plain full-page OAuth round trip (no shared session/cookie
      // between this API and the SPA origin) — the SPA's /oauth/callback
      // route immediately consumes it and never persists the URL itself.
      // Same branch AuthService.login already has: an account with 2FA
      // enabled gets a short-lived challenge token instead of a real
      // session — OAuthCallbackPage recognizes `?challenge=` and routes to
      // the same 2FA-entry step password login uses, rather than logging
      // straight in.
      const url =
        result.status === '2fa_required'
          ? `${frontendUrl}/oauth/callback?challenge=${encodeURIComponent(result.challengeToken)}`
          : `${frontendUrl}/oauth/callback?token=${encodeURIComponent(result.accessToken)}`;
      return { url, statusCode: 302 };
    } catch (err) {
      const detail = (err as { response?: { data?: unknown } }).response?.data ?? (err as Error).message;
      this.logger.error(`${provider} OAuth callback failed: ${JSON.stringify(detail)}`);
      return { url: `${frontendUrl}/login?oauth=error`, statusCode: 302 };
    }
  }
}
