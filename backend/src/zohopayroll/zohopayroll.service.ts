import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { IntegrationsService } from '../integrations/integrations.service';
import { SaveZohoAppCredentialsDto } from '../zoho/dto/save-app-credentials.dto';
import { accountsBaseUrlForRegion, ZOHO_DATA_CENTERS } from '../zoho/zoho-data-centers';

interface ZohoTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  api_domain?: string;
  error?: string;
}

interface ZohoPayrollOrganization {
  organization_id: string;
  name: string;
}

interface ZohoOAuthState {
  organizationId: string;
  purpose: 'zohopayroll-oauth';
}

interface ZohoAppCredentials {
  clientId: string;
  clientSecret: string;
  accountsBaseUrl: string;
}

export interface ZohoPayrollOrgOption {
  organizationId: string;
  name: string;
}

/**
 * Zoho Payroll OAuth — one connection per Haive ORGANIZATION, same shape as
 * zohobooks.service.ts (per-org "bring your own app" + regional data-center
 * pattern, reusing zoho-data-centers.ts/SaveZohoAppCredentialsDto — both
 * already generic, not CRM-specific). A FULLY SEPARATE credential from both
 * Zoho CRM ('zoho') and Zoho Books ('zohobooks') — provider 'zohopayroll' —
 * confirmed against Zoho's own current API docs (zoho.com/payroll/api/v1/):
 * base host www.zohoapis.com/payroll/v1 (+ .in/.ae/.sa data centers),
 * Zoho-oauthtoken auth scheme, organization_id required on every request —
 * i.e. the exact same API family as Zoho Books, not a different shape.
 *
 * Deliberately requests only a subset of Zoho's per-resource READ scopes:
 * settings/employee/payrollrun/department/designation/worklocation — NOT
 * salary.READ or loan.READ. Compensation figures are more sensitive than
 * general accounting data and there is no field-level redaction in this
 * codebase's AI-agent read path (only whole-endpoint allow/deny), so the
 * conservative choice is to keep salary amounts out of what's requested at
 * all in this pass, matching the spec's "payroll-specific access
 * restrictions" requirement and the precedent set by myob.service.ts
 * excluding the sme-payroll scope. Broadening this is a deliberate future
 * decision, not an oversight.
 */
@Injectable()
export class ZohoPayrollService {
  private readonly logger = new Logger(ZohoPayrollService.name);

  constructor(
    private config: ConfigService,
    private http: HttpService,
    private jwt: JwtService,
    private integrations: IntegrationsService,
  ) {}

  private async resolveAppCredentials(organizationId: string): Promise<ZohoAppCredentials> {
    const saved = await this.integrations.resolveOAuthAppCredentials(organizationId, 'zohopayroll');
    if (saved) {
      const accountsBaseUrl =
        saved.meta?.accountsServer || this.config.get<string>('integrations.zohopayroll.accountsBaseUrl') || 'https://accounts.zoho.com';
      return { clientId: saved.clientId, clientSecret: saved.clientSecret, accountsBaseUrl };
    }

    const platformClientId = this.config.get<string>('integrations.zohopayroll.clientId');
    const platformClientSecret = this.config.get<string>('integrations.zohopayroll.clientSecret');
    if (!platformClientId || !platformClientSecret) {
      throw new BadRequestException({
        code: 'ZOHOPAYROLL_APP_CREDENTIALS_REQUIRED',
        message: 'Zoho Payroll needs your Zoho API Console credentials before it can connect — enter them first.',
      });
    }
    return {
      clientId: platformClientId,
      clientSecret: platformClientSecret,
      accountsBaseUrl: this.config.get<string>('integrations.zohopayroll.accountsBaseUrl') ?? 'https://accounts.zoho.com',
    };
  }

  async saveAppCredentials(organizationId: string, dto: SaveZohoAppCredentialsDto): Promise<{ configured: true }> {
    const accountsServer = accountsBaseUrlForRegion(dto.region, dto.accountsServerUrl);
    await this.integrations.saveOAuthAppCredentials(organizationId, 'zohopayroll', {
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret.trim(),
      meta: { accountsServer, region: dto.region },
    });
    return { configured: true };
  }

  async getAppCredentialsStatus(organizationId: string) {
    const status = await this.integrations.getOAuthAppCredentialsStatus(organizationId, 'zohopayroll');
    return { ...status, dataCenters: ZOHO_DATA_CENTERS };
  }

  async buildAuthorizeUrl(organizationId: string): Promise<string> {
    const app = await this.resolveAppCredentials(organizationId);
    const redirectUri = this.config.get<string>('integrations.zohopayroll.redirectUri');
    const state = this.jwt.sign({ organizationId, purpose: 'zohopayroll-oauth' } satisfies ZohoOAuthState, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: app.clientId,
      response_type: 'code',
      redirect_uri: redirectUri ?? '',
      // Read-only, and deliberately excludes salary/loan scopes — see the
      // class doc comment above.
      scope: [
        'ZohoPayroll.settings.READ',
        'ZohoPayroll.employee.READ',
        'ZohoPayroll.payrollrun.READ',
        'ZohoPayroll.department.READ',
        'ZohoPayroll.designation.READ',
        'ZohoPayroll.worklocation.READ',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${app.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/auth?${params.toString()}`;
  }

  async handleCallback(code: string, state: string, accountsServerFromCallback?: string): Promise<{ orgs: ZohoPayrollOrgOption[]; needsSelection: boolean }> {
    let payload: ZohoOAuthState;
    try {
      payload = this.jwt.verify<ZohoOAuthState>(state);
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (payload.purpose !== 'zohopayroll-oauth' || !payload.organizationId) {
      throw new UnauthorizedException('Invalid state');
    }
    const organizationId = payload.organizationId;

    const app = await this.resolveAppCredentials(organizationId);
    const accountsServer = accountsServerFromCallback || app.accountsBaseUrl;
    const tokens = await this.exchangeCode(code, accountsServer, app);
    const apiDomain = tokens.api_domain ?? '';

    const zohoOrgs = await this.listOrganizations(apiDomain, tokens.access_token!);
    if (zohoOrgs.length === 0) {
      throw new BadRequestException('Zoho Payroll did not report any organisation for this account.');
    }
    const orgs = zohoOrgs.map((o) => ({ organizationId: o.organization_id, name: o.name }));
    const single = zohoOrgs.length === 1 ? zohoOrgs[0] : undefined;

    await this.integrations.connectWithOAuth(
      organizationId,
      'zohopayroll',
      {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresInSeconds: tokens.expires_in ?? 3600,
        oauthMeta: {
          accountsServer,
          payrollApiDomain: apiDomain,
          organizations: JSON.stringify(orgs),
          ...(single ? { payrollOrganizationId: single.organization_id, payrollOrganizationName: single.name } : {}),
        },
      },
      { skipSync: true },
    );

    return { orgs, needsSelection: zohoOrgs.length > 1 };
  }

  /** Finishes a multi-organisation connection — mirrors
   * zohobooks.service.ts's selectOrganization exactly. */
  async selectOrganization(organizationId: string, payrollOrganizationId: string): Promise<void> {
    const auth = await this.integrations.resolveAuth(organizationId, 'zohopayroll');
    if (!auth) throw new BadRequestException('Zoho Payroll isn’t connected yet.');
    const orgs = JSON.parse(auth.oauthMeta?.organizations ?? '[]') as ZohoPayrollOrgOption[];
    const match = orgs.find((o) => o.organizationId === payrollOrganizationId);
    if (!match) throw new BadRequestException('That organisation wasn’t part of this Zoho Payroll authorization.');
    await this.integrations.mergeOAuthMeta(organizationId, 'zohopayroll', {
      payrollOrganizationId: match.organizationId,
      payrollOrganizationName: match.name,
    });
  }

  async getStatus(organizationId: string): Promise<{ connected: boolean; needsSelection: boolean; organizationName?: string; orgs?: ZohoPayrollOrgOption[] }> {
    const auth = await this.integrations.resolveAuth(organizationId, 'zohopayroll');
    if (!auth) return { connected: false, needsSelection: false };
    const orgs = JSON.parse(auth.oauthMeta?.organizations ?? '[]') as ZohoPayrollOrgOption[];
    return {
      connected: true,
      needsSelection: !auth.oauthMeta?.payrollOrganizationId,
      organizationName: auth.oauthMeta?.payrollOrganizationName,
      orgs: orgs.length > 1 ? orgs : undefined,
    };
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.integrations.disconnect(organizationId, 'zohopayroll');
  }

  private async exchangeCode(code: string, accountsServer: string, app: ZohoAppCredentials): Promise<ZohoTokenResponse> {
    const redirectUri = this.config.get<string>('integrations.zohopayroll.redirectUri');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri ?? '',
      code,
    });

    const { data } = await firstValueFrom(
      this.http.post<ZohoTokenResponse>(`${accountsServer.replace(/\/$/, '')}/oauth/v2/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    if (!data.access_token || !data.refresh_token) {
      throw new Error(
        data.error ??
          'Zoho Payroll did not return an access/refresh token pair — check that access_type=offline and prompt=consent were sent, and that this is a first-time consent.',
      );
    }
    return data;
  }

  private async listOrganizations(apiDomain: string, accessToken: string): Promise<ZohoPayrollOrganization[]> {
    const { data } = await firstValueFrom(
      this.http.get<{ organizations?: ZohoPayrollOrganization[] }>(`${apiDomain.replace(/\/$/, '')}/payroll/v1/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      }),
    );
    return data.organizations ?? [];
  }
}
