import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { ConnectIntegrationDto } from '../integrations/dto/connect-integration.dto';
import { IntegrationsService } from '../integrations/integrations.service';

const PROVIDER = 'gorilladash';

export interface GorillaDashStatus {
  connected: boolean;
  keyMasked?: string;
  // An organisation key sees every location; a location ("tribe") key sees
  // only its own (and can't search locations). Unknown when the check failed.
  keyScope?: 'organization' | 'location' | 'unknown';
}

// Connecting Gorilla Dash (docs.gorilladash.com): an API key + secret pair,
// checked against /api/v1/ping before it's saved. Syncing (python-agent's
// crm_adapters.GorillaDashAdapter) and the AI tools read the saved pair.
@Injectable()
export class GorillaDashService {
  private readonly logger = new Logger(GorillaDashService.name);

  constructor(
    private integrations: IntegrationsService,
    private http: HttpService,
    private config: ConfigService,
  ) {}

  get baseUrl(): string {
    return (this.config.get<string>('gorilladash.apiBaseUrl') ?? 'https://api.gorilladash.com').replace(/\/+$/, '');
  }

  private headers(key: string, secret: string) {
    return { 'GorillaDash-Api-Key': key, 'GorillaDash-Api-Secret': secret, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
  }

  // Gorilla Dash answers successful calls with 201, not 200.
  private accept = (status: number) => status >= 200 && status < 300;

  private async credentials(organizationId: string): Promise<{ key: string; secret: string } | null> {
    const auth = await this.integrations.resolveAuth(organizationId, PROVIDER);
    if (!auth || auth.authType !== 'basic' || !auth.credentials.username || !auth.credentials.password) return null;
    return { key: auth.credentials.username, secret: auth.credentials.password };
  }

  private mask(key: string): string {
    return key.length > 8 ? `${key.slice(0, 4)}${'•'.repeat(Math.min(12, key.length - 6))}${key.slice(-2)}` : '••••';
  }

  /** Whether the key covers the whole organisation: a location key gets a 403
   * on the location search. */
  private async keyScope(key: string, secret: string): Promise<GorillaDashStatus['keyScope']> {
    try {
      await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/api/v1/tribes/search`,
          { name: '' },
          {
            headers: { ...this.headers(key, secret), 'Content-Type': 'application/json' },
            params: { results: 1 },
            timeout: 15_000,
            validateStatus: this.accept,
          },
        ),
      );
      return 'organization';
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      if (status === 403) return 'location';
      // 422 (the empty search itself was rejected) still means the key was allowed to search.
      if (status === 422) return 'organization';
      return 'unknown';
    }
  }

  async status(organizationId: string): Promise<GorillaDashStatus> {
    const creds = await this.credentials(organizationId);
    if (!creds) return { connected: false };
    return { connected: true, keyMasked: this.mask(creds.key), keyScope: await this.keyScope(creds.key, creds.secret) };
  }

  async connect(organizationId: string, key: string, secret: string): Promise<GorillaDashStatus> {
    try {
      await firstValueFrom(this.http.get(`${this.baseUrl}/api/v1/ping`, { headers: this.headers(key, secret), timeout: 15_000, validateStatus: this.accept }));
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      throw new BadRequestException(
        status === 401
          ? 'Gorilla Dash didn’t accept this API key and secret. Copy both again from Gorilla Dash’s API settings.'
          : status === 403
            ? 'The key is valid, but the API isn’t turned on for this Gorilla Dash account. Ask Gorilla Dash to enable API access, then try again.'
            : status
              ? `Gorilla Dash returned an error (HTTP ${status}). Try again in a minute.`
              : 'Couldn’t reach Gorilla Dash. Check the connection and try again.',
      );
    }
    // Saving it as a CRM integration also creates its data source and starts
    // the first sync (IntegrationsService -> DataSourcesService.reconcile).
    await this.integrations.connectWithAuth(organizationId, PROVIDER, {
      authType: 'basic',
      credentials: { username: key, password: secret },
      baseUrl: this.baseUrl,
    } as ConnectIntegrationDto);
    this.logger.log(`Gorilla Dash connected for org ${organizationId}`);
    return { connected: true, keyMasked: this.mask(key), keyScope: await this.keyScope(key, secret) };
  }

  disconnect(organizationId: string): Promise<void> {
    return this.integrations.disconnect(organizationId, PROVIDER);
  }
}
