import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { CRM_PROVIDERS, CrmProviderDefinition, CrmProviderId, connectionOf, crmProviderForIntegration } from '../data-sources/provider-catalog';
import { webhookInfo } from '../data-sources/webhook-info';
import { WebhookSourcesService } from '../data-sources/webhook-sources.service';
import { GorillaDashService } from '../gorilladash/gorilladash.service';
import { ConnectIntegrationDto } from '../integrations/dto/connect-integration.dto';
import { IntegrationsService } from '../integrations/integrations.service';

export interface SetupField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url';
  hint?: string;
  placeholder?: string;
  required: boolean;
  // Pre-filled, and tucked under "Advanced" — most customers never change it.
  defaultValue?: string;
  advanced?: boolean;
}

interface ProviderSetup {
  // What the customer is asked for. Empty for a push provider: nothing is typed into HaiVE.
  // Also empty for an OAuth provider (authMethod: 'oauth' below) — there's
  // no form at all, the "Connect" step redirects to the provider instead.
  fields: SetupField[];
  // Plain-language list of what this CRM gives HaiVE, and what it can't.
  provides: string[];
  limitations: string[];
  // Push providers: how records get here, step by step.
  steps?: string[];
  // Set for Zoho/Salesforce (see ../zoho/, ../salesforce/): the frontend's
  // "Connect" step renders a redirect button instead of fields — `fields` is
  // always [] when this is set. Undefined means the existing typed-credential
  // form (every other provider here).
  authMethod?: 'oauth';
}

// What each CRM needs to connect — the one place the Integrations page's
// setup form comes from, so choosing Hoops never shows a Pantheras field (and
// vice versa). Adding a CRM is: a catalog entry + a sync adapter (pull) or
// nothing (push) + an entry here.
const SETUP: Partial<Record<CrmProviderId, ProviderSetup>> = {
  prospectconnect: {
    fields: [
      { key: 'apiToken', label: 'API token', type: 'password', required: true, hint: 'From Pantheras CRM → Settings → API access.' },
      { key: 'baseUrl', label: 'Server address', type: 'url', required: true, defaultValue: 'https://api.prospectconnect.ai', advanced: true },
    ],
    provides: ['Deals and pipeline', 'Quotations and their approval', 'Payments against quotations', 'Salesperson on each deal'],
    limitations: [],
  },
  gorilladash: {
    fields: [
      { key: 'apiKey', label: 'API key', type: 'text', required: true, hint: 'Gorilla Dash → Settings → API. An organisation key sees every location.' },
      { key: 'apiSecret', label: 'API secret', type: 'password', required: true },
    ],
    provides: ['Enquiries (leads) with the customer’s message', 'People (contacts)', 'Lead source and campaign', 'Location'],
    limitations: ['No quotations, deal values, payments or salesperson — those come from HaiVE’s own quotes when the customer matches.'],
  },
  hoops: {
    fields: [],
    provides: ['New customers, as they are created', 'New jobs, as they are created'],
    limitations: [
      'Hoops has no API HaiVE can read from: only new customers and jobs can be sent, through Hoops’ Zapier connection.',
      'SalesDocs (quotes), payments and records created before you connect are not available from Hoops.',
    ],
    steps: [
      'In Hoops, open Settings → Integrations and click “Generate API Key” on the Zapier tile.',
      'In Zapier, add a connection for “Hoops” and paste that key.',
      'Create a Zap for each kind of record — Trigger: Hoops “New Customer” (or “New Job”) → Action: “Webhooks by Zapier” → POST, payload type JSON.',
      'Use the HaiVE address below for that kind of record, and add the header X-HaiVE-Key with the key below.',
      'In the Zap’s Data, include the record’s id and the fields you want in HaiVE, then test the step and turn the Zap on.',
    ],
  },
  zoho: {
    fields: [],
    authMethod: 'oauth',
    provides: ['Deals and pipeline stages', 'Contacts', 'Accounts', 'Automatic token refresh — no re-entering credentials'],
    limitations: ['No quotations module — Zoho CRM has no separate quote object synced today.'],
  },
  salesforce: {
    fields: [],
    authMethod: 'oauth',
    provides: ['Opportunities and pipeline stages', 'Contacts', 'Accounts', 'Automatic token refresh — no re-entering credentials'],
    limitations: ['No quotations module — Salesforce Opportunities are read as deals; Salesforce Quotes are not synced today.'],
  },
};

// The CRMs offered on the Integrations page, in this order.
const OFFERED: CrmProviderId[] = ['prospectconnect', 'hoops', 'gorilladash', 'zoho', 'salesforce'];

export interface CrmIntegrationView {
  id: string;
  label: string;
  description: string;
  connection: 'pull' | 'push';
  setup: ProviderSetup;
  status: 'not_connected' | 'connected' | 'waiting' | 'needs_attention';
  source?: {
    id: string;
    label: string;
    isDefault: boolean;
    health: 'healthy' | 'failing' | 'not_synced' | 'syncing';
    lastSyncAt?: Date;
    lastSuccessAt?: Date;
    records: Record<string, number>;
    totalRecords: number;
    terminology: Record<string, string>;
    modules: string[];
    error?: { message: string; kind: string; detail?: string };
    webhook?: ReturnType<typeof webhookInfo>;
  };
}

// The provider-aware face of CRM integrations for the Integrations page: what
// can be connected, what each one needs, how each connected one is doing —
// and connecting/disconnecting them. The work itself stays where it was: the
// sync adapters (python), the data-source layer (mappings, isolation) and the
// push webhook. Everything here is scoped to the caller's organization.
@Injectable()
export class CrmIntegrationsService {
  private readonly logger = new Logger(CrmIntegrationsService.name);
  private readonly pythonAgentUrl: string;
  private readonly webhookBaseUrl: string;

  constructor(
    @InjectConnection() private connection: Connection,
    private dataSources: DataSourcesService,
    private webhookSources: WebhookSourcesService,
    private integrations: IntegrationsService,
    private gorillaDash: GorillaDashService,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
    this.webhookBaseUrl = config.get<string>('dataSources.webhookBaseUrl') ?? '';
  }

  private definition(provider: string): CrmProviderDefinition & { setup: ProviderSetup } {
    const definition = CRM_PROVIDERS[provider as CrmProviderId];
    const setup = SETUP[provider as CrmProviderId];
    if (!definition || !setup) throw new NotFoundException('That integration isn’t available.');
    return { ...definition, setup };
  }

  private async sourceOf(organizationId: string, provider: string) {
    const sources = await this.connection.collection('crm_data_sources').find({ organizationId, provider }).sort({ createdAt: 1 }).toArray();
    return sources.find((s) => s.status === 'active') ?? null;
  }

  private async view(organizationId: string, provider: string, counts?: Map<string, Record<string, number>>): Promise<CrmIntegrationView> {
    const definition = this.definition(provider);
    const connection = connectionOf(definition) === 'push' ? 'push' : 'pull';
    const base = { id: definition.id, label: definition.label, description: definition.description, connection, setup: definition.setup } as const;
    const source = await this.sourceOf(organizationId, provider);
    if (!source) return { ...base, status: 'not_connected' };

    const sourceId = source._id.toString();
    const records: Record<string, number> = {};
    for (const [module, collection] of [
      ['deals', 'crm_deals'],
      ['quotes', 'crm_quotes'],
      ['contacts', 'crm_contacts'],
      ['accounts', 'crm_accounts'],
    ] as const) {
      if (!((source.modules as string[]) ?? []).includes(module)) continue;
      records[module] =
        counts?.get(sourceId)?.[module] ?? (await this.connection.collection(collection).countDocuments({ organizationId, dataSourceId: sourceId }));
    }
    const totalRecords = Object.values(records).reduce((a, b) => a + b, 0);
    const sync = (source.sync ?? {}) as Record<string, any>;
    const failing = sync.lastStatus === 'error';
    const health = sync.lastStatus === 'running' ? 'syncing' : failing ? 'failing' : sync.lastSyncAt ? 'healthy' : 'not_synced';
    return {
      ...base,
      // A push source with nothing received yet is set up but still waiting for its first record.
      status: failing ? 'needs_attention' : connection === 'push' && totalRecords === 0 ? 'waiting' : 'connected',
      source: {
        id: sourceId,
        label: String(source.label),
        isDefault: !!source.isDefault,
        health,
        lastSyncAt: sync.lastSyncAt,
        lastSuccessAt: sync.lastSuccessAt ?? (failing ? undefined : sync.lastSyncAt),
        records,
        totalRecords,
        terminology: { ...definition.terminology, ...((source.terminology as Record<string, string>) ?? {}) },
        modules: (source.modules as string[]) ?? [],
        error: failing
          ? {
              message: String(sync.lastError ?? 'The last sync didn’t complete.'),
              kind: String(sync.lastErrorKind ?? 'other'),
              detail: sync.lastErrorDetail ? String(sync.lastErrorDetail) : undefined,
            }
          : undefined,
        webhook: connection === 'push' ? webhookInfo(source as never, this.webhookBaseUrl) : undefined,
      },
    };
  }

  async list(organizationId: string): Promise<CrmIntegrationView[]> {
    return Promise.all(OFFERED.map((provider) => this.view(organizationId, provider)));
  }

  /** Reads one page of each kind of record through the CRM's adapter: proves the connection and learns its fields. */
  private async discover(organizationId: string, sourceId: string) {
    const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '5m' });
    const { data } = await firstValueFrom(
      this.http.post<{ status: string; modules?: Record<string, { records: number; fields: number }>; message?: string; kind?: string; detail?: string }>(
        `${this.pythonAgentUrl}/sync/crm/discover`,
        { dataSourceId: sourceId },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 120_000 },
      ),
    );
    return data;
  }

  private async credentialNames(organizationId: string, provider: string): Promise<string[]> {
    const rows = await this.connection
      .collection('integration_credentials')
      .find({ organizationId }, { projection: { provider: 1 } })
      .toArray();
    return rows.map((r) => String(r.provider)).filter((name) => crmProviderForIntegration(name)?.id === provider);
  }

  /**
   * Connects a CRM. Pull CRMs: the credentials are saved, then one page of
   * data is read to prove they work — if that fails nothing is kept (a
   * previous working connection is put back). No records are synced yet: the
   * customer reviews the mapping first. Push CRMs: HaiVE creates the address
   * and key the CRM's automation sends to (the key is returned once).
   */
  async connect(organizationId: string, provider: string, credentials: Record<string, string>) {
    const definition = this.definition(provider);
    if (definition.setup.authMethod === 'oauth') {
      // Zoho/Salesforce never reach this method under normal use — the
      // frontend's "Connect" step redirects to GET /zoho/connect-url or
      // /salesforce/connect-url instead of submitting this form (see
      // CrmSetupWizard.tsx). Guards a stale client/direct API call with a
      // clear message rather than the generic "can't be connected from here
      // yet" below, which would be actively misleading once it IS connectable.
      throw new BadRequestException(`${definition.label} connects via "Connect with ${definition.label}" above, not a typed form.`);
    }
    if (connectionOf(definition) === 'push') {
      const created = await this.webhookSources.create(organizationId, { provider: definition.id });
      return { integration: await this.view(organizationId, provider), webhookKey: created.key };
    }

    const values: Record<string, string> = {};
    for (const field of definition.setup.fields) {
      const value = String(credentials?.[field.key] ?? field.defaultValue ?? '').trim();
      if (field.required && !value) throw new BadRequestException(`Enter the ${field.label.toLowerCase()}.`);
      values[field.key] = value;
    }

    const previousNames = await this.credentialNames(organizationId, provider);
    const previous = previousNames.length ? await this.integrations.resolveAuth(organizationId, previousNames[0]) : null;
    const rollback = async () => {
      for (const name of await this.credentialNames(organizationId, provider)) await this.integrations.disconnect(organizationId, name);
      if (previous) {
        await this.integrations.connectWithAuth(
          organizationId,
          previousNames[0],
          { authType: previous.authType, credentials: previous.credentials, baseUrl: previous.baseUrl } as ConnectIntegrationDto,
          { skipSync: true },
        );
      }
    };

    if (provider === 'gorilladash') {
      // Checks the pair against Gorilla Dash before saving it (and explains a rejected key itself).
      await this.gorillaDash.connect(organizationId, values.apiKey, values.apiSecret, { skipSync: true });
    } else if (provider === 'prospectconnect') {
      let baseUrl: string;
      try {
        const url = new URL(values.baseUrl);
        if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('not https');
        baseUrl = url.origin;
      } catch {
        throw new BadRequestException('The server address must be a full https:// address.');
      }
      for (const name of previousNames) await this.integrations.disconnect(organizationId, name);
      await this.integrations.connectWithAuth(
        organizationId,
        'prospectconnect',
        { authType: 'bearer', credentials: { bearerToken: values.apiToken.replace(/^Bearer\s+/i, '') }, baseUrl } as ConnectIntegrationDto,
        { skipSync: true },
      );
    } else {
      throw new BadRequestException(`${definition.label} can’t be connected from here yet.`);
    }

    const source = await this.sourceOf(organizationId, provider);
    if (!source) {
      await rollback();
      throw new BadRequestException(`${definition.label} couldn’t be set up. Please try again.`);
    }
    let discovery: Awaited<ReturnType<CrmIntegrationsService['discover']>>;
    try {
      discovery = await this.discover(organizationId, source._id.toString());
    } catch (err) {
      await rollback();
      await this.dataSources.reconcile(organizationId);
      this.logger.error(`Discovery call failed for ${provider} (org ${organizationId}): ${(err as Error).message}`);
      throw new BadRequestException('HaiVE couldn’t check the connection right now. Nothing was saved — please try again in a minute.');
    }
    if (discovery.status !== 'ok') {
      await rollback();
      await this.dataSources.reconcile(organizationId);
      this.logger.warn(`${provider} connection refused for org ${organizationId}: ${discovery.detail ?? discovery.message}`);
      throw new BadRequestException({
        message:
          discovery.kind === 'auth'
            ? `${definition.label} didn’t accept these details. Check them and try again — nothing was saved.`
            : `HaiVE couldn’t read from ${definition.label}. ${discovery.message ?? ''} Nothing was saved.`.trim(),
        kind: discovery.kind ?? 'other',
        detail: discovery.detail,
      });
    }
    return { integration: await this.view(organizationId, provider), discovery: discovery.modules ?? {} };
  }

  /** Re-reads a first page (after the first record of a push CRM arrives there is nothing to call — the samples are already kept). */
  async rediscover(organizationId: string, provider: string) {
    const definition = this.definition(provider);
    const source = await this.sourceOf(organizationId, provider);
    if (!source) throw new BadRequestException(`${definition.label} isn’t connected.`);
    if (connectionOf(definition) === 'push') return { status: 'ok', modules: {} };
    return this.discover(organizationId, source._id.toString());
  }

  async disconnect(organizationId: string, provider: string) {
    const definition = this.definition(provider);
    const source = await this.sourceOf(organizationId, provider);
    if (connectionOf(definition) === 'push') {
      if (source) await this.webhookSources.disconnect(organizationId, source._id.toString());
    } else {
      // Every name this CRM was saved under (e.g. "crm" and "prospectconnect").
      for (const name of await this.credentialNames(organizationId, provider)) await this.integrations.disconnect(organizationId, name);
      await this.dataSources.reconcile(organizationId);
    }
    return this.view(organizationId, provider);
  }

  /** A new key for a push CRM (the old one stops working at once). */
  async rotateKey(organizationId: string, provider: string) {
    const source = await this.sourceOf(organizationId, provider);
    if (!source || connectionOf(this.definition(provider)) !== 'push') throw new BadRequestException('This integration has no key to replace.');
    const rotated = await this.webhookSources.rotateKey(organizationId, source._id.toString());
    return { integration: await this.view(organizationId, provider), webhookKey: rotated.key };
  }

  async syncNow(organizationId: string, provider: string) {
    const definition = this.definition(provider);
    const source = await this.sourceOf(organizationId, provider);
    if (!source) throw new BadRequestException(`${definition.label} isn’t connected.`);
    if (connectionOf(definition) === 'push') {
      throw new BadRequestException(`${definition.label} sends records to HaiVE as they are created — there is nothing to pull.`);
    }
    const result = await this.dataSources.syncNow(organizationId, source._id.toString());
    return { result, integration: await this.view(organizationId, provider) };
  }

  async history(organizationId: string, provider: string) {
    const source = await this.sourceOf(organizationId, provider);
    if (!source) return [];
    const runs = await this.connection
      .collection('crm_sync_runs')
      .find({ organizationId, dataSourceId: source._id.toString() })
      .sort({ startedAt: -1 })
      .limit(25)
      .toArray();
    return runs.map((r) => ({
      id: r._id.toString(),
      trigger: r.trigger as string,
      status: r.status as string,
      startedAt: r.startedAt as Date,
      finishedAt: r.finishedAt as Date,
      counts: (r.counts ?? {}) as Record<string, number>,
      processed: Object.values((r.counts ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0),
      failed: (r.failed as number | undefined) ?? 0,
      error: r.error as string | undefined,
      errorKind: r.errorKind as string | undefined,
      errorDetail: r.errorDetail as string | undefined,
    }));
  }

  async makeDefault(organizationId: string, provider: string) {
    const source = await this.sourceOf(organizationId, provider);
    if (!source) throw new BadRequestException('Connect it first.');
    await this.dataSources.update(organizationId, source._id.toString(), { isDefault: true });
    return this.view(organizationId, provider);
  }
}
