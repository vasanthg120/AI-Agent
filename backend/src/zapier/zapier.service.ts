import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { Connection } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { ConnectIntegrationDto } from '../integrations/dto/connect-integration.dto';
import { IntegrationsService } from '../integrations/integrations.service';

const PROVIDER = 'zapier';

export interface ZapierApp {
  app: string;
  read: string[];
  write: string[];
}

export interface ZapierStatus {
  connected: boolean;
  tokenMasked?: string;
  // managed: each enabled action is its own tool (what HaiVE needs);
  // agentic: Zapier's meta-tools only — the admin must switch modes.
  mode?: 'managed' | 'agentic';
  apps?: ZapierApp[];
  toolCount?: number;
  refreshedAt?: Date;
  error?: string | null;
}

// Zapier as a connector (Zapier MCP, https://docs.zapier.com/mcp): the
// administrator pastes their Zapier MCP server's connection token; it's stored
// encrypted as the organization's "zapier" integration and only ever used
// server-side, by python-agent (app/integrations/zapier_mcp.py), which lists
// the server's actions per app (Hoops, Gorilla Dash, …) and runs them for the
// AI. This service connects, refreshes and reports — it never returns the token.
@Injectable()
export class ZapierService {
  private readonly logger = new Logger(ZapierService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    private integrations: IntegrationsService,
    private http: HttpService,
    private jwt: JwtService,
    @InjectConnection() private connection: Connection,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private mask(token: string): string {
    return token.length > 10 ? `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-3)}` : '••••';
  }

  private async token(organizationId: string): Promise<string | null> {
    const auth = await this.integrations.resolveAuth(organizationId, PROVIDER);
    if (!auth) return null;
    if (auth.authType === 'bearer') return (auth.credentials.bearerToken ?? '').replace(/^Bearer\s+/i, '').trim() || null;
    return (auth.credentials.apiKey ?? '').trim() || null;
  }

  /** python-agent lists (and caches) the Zapier server's actions for this organization. */
  private async discover(organizationId: string): Promise<void> {
    const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '5m' });
    try {
      await firstValueFrom(
        this.http.post(`${this.pythonAgentUrl}/integrations/zapier/discover`, {}, { headers: { Authorization: `Bearer ${token}` }, timeout: 90_000 }),
      );
    } catch (err) {
      const response = (err as AxiosError<{ detail?: unknown }>).response;
      const detail = response?.data?.detail;
      throw new BadRequestException(
        typeof detail === 'string' && response?.status === 422
          ? detail
          : 'Couldn’t reach the AI service to check the Zapier connection. Try again in a minute.',
      );
    }
  }

  async status(organizationId: string): Promise<ZapierStatus> {
    const token = await this.token(organizationId);
    if (!token) return { connected: false };
    const catalog = await this.connection.collection('zapier_catalogs').findOne(
      { organizationId },
      {
        projection: {
          _id: 0,
          tools: 1,
          mode: 1,
          apps: 1,
          refreshedAt: 1,
          error: 1,
        },
      },
    );
    return {
      connected: true,
      tokenMasked: this.mask(token),
      mode: catalog?.mode as ZapierStatus['mode'],
      apps: (catalog?.apps as ZapierApp[] | undefined) ?? [],
      toolCount: Array.isArray(catalog?.tools) ? catalog.tools.length : 0,
      refreshedAt: catalog?.refreshedAt as Date | undefined,
      error: (catalog?.error as string | null | undefined) ?? null,
    };
  }

  /** Saves the token only if Zapier accepts it (a first action listing succeeds). */
  async connect(organizationId: string, rawToken: string): Promise<ZapierStatus> {
    const token = rawToken.replace(/^Bearer\s+/i, '').trim();
    const previous = await this.integrations.resolveAuth(organizationId, PROVIDER);
    await this.integrations.connectWithAuth(organizationId, PROVIDER, {
      authType: 'bearer',
      credentials: { bearerToken: token },
    } as ConnectIntegrationDto);
    try {
      await this.discover(organizationId);
    } catch (err) {
      // Put back what was there before (or nothing), so a bad token never replaces a working one.
      if (previous) {
        await this.integrations.connectWithAuth(organizationId, PROVIDER, {
          authType: previous.authType,
          credentials: previous.credentials,
        } as ConnectIntegrationDto);
        await this.discover(organizationId).catch(() => undefined);
      } else {
        await this.integrations.disconnect(organizationId, PROVIDER);
        await this.connection.collection('zapier_catalogs').deleteOne({ organizationId });
      }
      throw err;
    }
    this.logger.log(`Zapier connected for org ${organizationId}`);
    return this.status(organizationId);
  }

  async refresh(organizationId: string): Promise<ZapierStatus> {
    if (!(await this.token(organizationId))) throw new BadRequestException('Zapier isn’t connected.');
    // A failure (e.g. a revoked token) is recorded on the catalog — reported through status.
    await this.discover(organizationId).catch(() => undefined);
    return this.status(organizationId);
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.integrations.disconnect(organizationId, PROVIDER);
    await this.connection.collection('zapier_catalogs').deleteOne({ organizationId });
  }
}
