import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { DataSourceScope, SelectionMode } from './data-source-context';
import { UpdateDataSourceDto } from './dto/update-data-source.dto';
import { METRICS, MetricDefinition, crmMetricSupport } from './metric-catalog';
import {
  CANONICAL_FIELDS,
  CRM_INTEGRATION_PROVIDERS,
  CRM_MODULES,
  CRM_PROVIDERS,
  CrmModule,
  CrmProviderDefinition,
  FieldMappings,
  MirroredModule,
  crmProviderForIntegration,
} from './provider-catalog';
import { DataSource, DataSourceDocument } from './schemas/data-source.schema';
import { WEBHOOK_PROVIDER, webhookInfo } from './webhook-info';

const NATIVE_KEY = 'haive';
const CACHE_TTL_MS = 30_000;
const MIRRORED: Array<{ module: MirroredModule; collection: string }> = [
  { module: 'deals', collection: 'crm_deals' },
  { module: 'quotes', collection: 'crm_quotes' },
  { module: 'contacts', collection: 'crm_contacts' },
  { module: 'accounts', collection: 'crm_accounts' },
];
// A field path like "properties.amount", "client_details.company_name" or "Owner.id".
const FIELD_PATH = /^[A-Za-z_$][\w$-]*(\.[\w$-]+)*$/;
const MAX_VALUES = 50;

export interface MetricAvailability {
  id: string;
  label: string;
  kind: 'crm' | 'email';
  status: 'supported' | 'not_supported' | 'no_source';
  // Where the number comes from, in words ("HubSpot", "Outlook").
  sources: string[];
  reason?: string;
}

export interface DataSourceView {
  id: string;
  key: string;
  provider: string;
  providerLabel: string;
  label: string;
  status: string;
  isDefault: boolean;
  native: boolean;
  modules: CrmModule[];
  terminology: DataSource['terminology'];
  sync: DataSource['sync'] & { supported: boolean };
  recordCounts: Record<MirroredModule, number>;
  supportedMetrics: string[];
}

export interface EmailSourceView {
  provider: 'outlook' | 'gmail';
  label: string;
  mailboxes: number;
  needsReconnect: number;
}

function cleanStrings(values: unknown, max = MAX_VALUES): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v ?? '').trim()).filter((v) => v && v.length <= 120))].slice(0, max);
}

// The data-source layer: which CRMs an organization takes data from, how each
// maps onto HaiVE's model, what each can and can't provide, and which one(s) a
// request is reading. See provider-catalog.ts and docs/crm-data-sources.md.
@Injectable()
export class DataSourcesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataSourcesService.name);
  private readonly cache = new Map<string, { at: number; sources: DataSourceDocument[] }>();
  private readonly pythonAgentUrl: string;
  private readonly webhookBaseUrl: string;

  constructor(
    @InjectModel(DataSource.name)
    private sourceModel: Model<DataSourceDocument>,
    @InjectConnection() private connection: Connection,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
    this.webhookBaseUrl = config.get<string>('dataSources.webhookBaseUrl') ?? '';
  }

  // ---- startup: one-time migration, then per-organization reconciliation ----

  async onApplicationBootstrap(): Promise<void> {
    // Not awaited: startup must never wait on (or fail because of) a backfill.
    void this.migrateAll().catch((err) => this.logger.error(`Data-source migration failed: ${(err as Error).message}`));
  }

  async migrateAll(): Promise<void> {
    await this.dropLegacyIndexes();
    const orgIds = (
      await this.connection
        .collection('organizations')
        .find({}, { projection: { _id: 1 } })
        .toArray()
    ).map((o) => o._id.toString());
    for (const organizationId of orgIds) {
      try {
        await this.reconcile(organizationId);
        await this.backfill(organizationId);
      } catch (err) {
        this.logger.error(`Data sources for org ${organizationId} could not be prepared: ${(err as Error).message}`);
      }
    }
  }

  /** "One record per external id per organization" became "…per data source":
   * two CRMs can legitimately use the same id for different records. */
  private async dropLegacyIndexes(): Promise<void> {
    for (const collection of ['crm_deals', 'crm_quotes']) {
      try {
        const indexes = await this.connection.collection(collection).indexes();
        if (indexes.some((i) => i.name === 'organizationId_1_externalId_1')) {
          await this.connection.collection(collection).dropIndex('organizationId_1_externalId_1');
          this.logger.log(`Replaced ${collection}'s per-organization external-id index with a per-source one.`);
        }
      } catch (err) {
        // Collection not created yet — nothing to migrate.
        if (!/ns not found|NamespaceNotFound/i.test((err as Error).message)) throw err;
      }
    }
  }

  /** Makes the organization's data sources match its connections: a HaiVE
   * workspace source always, one source per connected CRM, disconnected ones
   * kept (their history stays viewable) but marked, exactly one default. */
  async reconcile(organizationId: string): Promise<void> {
    const credentials = await this.connection
      .collection('integration_credentials')
      .find({ organizationId, provider: { $in: CRM_INTEGRATION_PROVIDERS } }, { projection: { provider: 1 } })
      .toArray();

    await this.ensureSource(organizationId, CRM_PROVIDERS.haive_native, NATIVE_KEY);
    const connectedKeys = new Set<string>();
    for (const cred of credentials) {
      const provider = crmProviderForIntegration(String(cred.provider));
      if (!provider) continue;
      connectedKeys.add(provider.id);
      await this.ensureSource(organizationId, provider, provider.id, {
        integrationProvider: String(cred.provider),
        connectionId: cred._id.toString(),
      });
    }

    await this.sourceModel
      // Webhook sources have no credential to find — they're (dis)connected on their own (WebhookSourcesService).
      .updateMany(
        {
          organizationId,
          key: { $nin: [NATIVE_KEY, ...connectedKeys] },
          provider: { $ne: WEBHOOK_PROVIDER },
          status: 'active',
        },
        { $set: { status: 'disconnected', isDefault: false } },
      )
      .exec();

    const sources = await this.sourceModel.find({ organizationId }).exec();
    const activeDefault = sources.find((s) => s.isDefault && s.status === 'active');
    if (!activeDefault) {
      // Prefer a connected external CRM (that's where the business's data is);
      // otherwise the HaiVE workspace.
      const pick = sources.find((s) => s.status === 'active' && s.key !== NATIVE_KEY) ?? sources.find((s) => s.key === NATIVE_KEY);
      if (pick) {
        await this.sourceModel.updateMany({ organizationId, _id: { $ne: pick._id } }, { $set: { isDefault: false } }).exec();
        await this.sourceModel.updateOne({ _id: pick._id }, { $set: { isDefault: true } }).exec();
      }
    }
    this.cache.delete(organizationId);
  }

  private async ensureSource(
    organizationId: string,
    provider: CrmProviderDefinition,
    key: string,
    link: { integrationProvider?: string; connectionId?: string } = {},
  ): Promise<void> {
    await this.sourceModel
      .updateOne(
        { organizationId, key },
        {
          // Defaults only when the source is first created — an administrator's
          // later edits (label, mappings, modules…) are never overwritten.
          $setOnInsert: {
            organizationId,
            key,
            provider: provider.id,
            label: provider.label,
            modules: provider.modules,
            terminology: provider.terminology,
            fieldMappings: provider.fieldMappings,
            statusMapping: provider.statusMapping,
            stageMappings: [],
            availableFields: {},
            sync: {
              enabled: provider.syncSupported,
              intervalMinutes: 10,
              lastStatus: 'never',
            },
            metadata: {},
            isDefault: false,
          },
          $set: { status: 'active', ...link },
        },
        { upsert: true },
      )
      .exec();
  }

  /** Tags records stored before data sources existed. Until now only the
   * customised CRM was ever synced, so an untagged record with an external id
   * came from it; anything else was created in HaiVE. */
  async backfill(organizationId: string): Promise<void> {
    const native = await this.sourceModel.findOne({ organizationId, key: NATIVE_KEY }).exec();
    if (!native) return;
    for (const { collection } of MIRRORED) {
      const col = this.connection.collection(collection);
      const untaggedExternal = await col.countDocuments({
        organizationId,
        dataSourceId: { $exists: false },
        externalId: { $exists: true },
      });
      if (untaggedExternal > 0) {
        let legacy = await this.sourceModel.findOne({ organizationId, key: 'prospectconnect' }).exec();
        if (!legacy) {
          // Synced from a CRM that has since been disconnected — keep its
          // history as its own (disconnected) source rather than relabelling it.
          await this.ensureSource(organizationId, CRM_PROVIDERS.prospectconnect, 'prospectconnect');
          await this.sourceModel.updateOne({ organizationId, key: 'prospectconnect' }, { $set: { status: 'disconnected' } }).exec();
          legacy = await this.sourceModel.findOne({ organizationId, key: 'prospectconnect' }).exec();
        }
        await col.updateMany(
          {
            organizationId,
            dataSourceId: { $exists: false },
            externalId: { $exists: true },
          },
          {
            $set: {
              dataSourceId: legacy!._id.toString(),
              sourceProvider: legacy!.provider,
            },
          },
        );
      }
      await col.updateMany(
        { organizationId, dataSourceId: { $exists: false } },
        {
          $set: {
            dataSourceId: native._id.toString(),
            sourceProvider: 'haive_native',
          },
        },
      );
    }
    this.cache.delete(organizationId);
  }

  // ---- per-request scope --------------------------------------------------

  private async sourcesFor(organizationId: string): Promise<DataSourceDocument[]> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.sources;
    let sources = await this.sourceModel.find({ organizationId }).sort({ createdAt: 1 }).exec();
    if (!sources.some((s) => s.key === NATIVE_KEY)) {
      await this.reconcile(organizationId);
      sources = await this.sourceModel.find({ organizationId }).sort({ createdAt: 1 }).exec();
    }
    this.cache.set(organizationId, { at: Date.now(), sources });
    return sources;
  }

  /**
   * Turns the caller's selection into the sources a request reads:
   *  - nothing / "default": the organization's default source;
   *  - "unified": every connected source — only ever when explicitly asked for;
   *  - a source id: that source (a disconnected one too, to look at its history).
   * An unknown or foreign id falls back to the default, never to "everything".
   */
  async resolveScope(organizationId: string, selection: string | undefined): Promise<DataSourceScope> {
    const sources = await this.sourcesFor(organizationId);
    const native = sources.find((s) => s.key === NATIVE_KEY)!;
    const fallback = sources.find((s) => s.isDefault) ?? native;
    const base = { organizationId, nativeSourceId: native._id.toString() };

    if (selection === 'unified') {
      const active = sources.filter((s) => s.status === 'active');
      return {
        ...base,
        mode: 'unified',
        sourceIds: active.map((s) => s._id.toString()),
      };
    }
    if (selection && selection !== 'default' && isValidObjectId(selection)) {
      const chosen = sources.find((s) => s._id.toString() === selection);
      if (chosen) return { ...base, mode: 'source', sourceIds: [chosen._id.toString()] };
    }
    return { ...base, mode: 'default', sourceIds: [fallback._id.toString()] };
  }

  // ---- views -----------------------------------------------------------------

  private capabilityOf(source: DataSourceDocument) {
    return {
      modules: source.modules ?? [],
      fieldMappings: source.fieldMappings ?? {},
      statusMapping: source.statusMapping ?? { won: [], lost: [] },
      native: source.provider === 'haive_native',
    };
  }

  private async recordCounts(organizationId: string): Promise<Map<string, Record<MirroredModule, number>>> {
    const counts = new Map<string, Record<MirroredModule, number>>();
    // Straight to the driver: these counts are about every source, and the
    // scoping plugin only applies to Mongoose models anyway.
    {
      for (const { module, collection } of MIRRORED) {
        const rows = await this.connection
          .collection(collection)
          .aggregate<{ _id: string | null; n: number }>([{ $match: { organizationId } }, { $group: { _id: '$dataSourceId', n: { $sum: 1 } } }])
          .toArray();
        for (const row of rows) {
          const key = row._id ?? '';
          const entry = counts.get(key) ?? {
            deals: 0,
            quotes: 0,
            contacts: 0,
            accounts: 0,
          };
          entry[module] = row.n;
          counts.set(key, entry);
        }
      }
    }
    return counts;
  }

  private toView(source: DataSourceDocument, counts: Map<string, Record<MirroredModule, number>>): DataSourceView {
    const provider = CRM_PROVIDERS[source.provider] ?? CRM_PROVIDERS.custom;
    const capability = this.capabilityOf(source);
    const zero = { deals: 0, quotes: 0, contacts: 0, accounts: 0 };
    const own = counts.get(source._id.toString()) ?? zero;
    // Untagged records are the HaiVE workspace's (see dataSourceScopePlugin).
    const untagged = source.key === NATIVE_KEY ? (counts.get('') ?? zero) : zero;
    return {
      id: source._id.toString(),
      key: source.key,
      provider: source.provider,
      providerLabel: provider.label,
      label: source.label,
      status: source.status,
      isDefault: source.isDefault,
      native: source.key === NATIVE_KEY,
      modules: capability.modules,
      terminology: { ...provider.terminology, ...(source.terminology ?? {}) },
      sync: { ...source.sync, supported: provider.syncSupported },
      recordCounts: {
        deals: own.deals + untagged.deals,
        quotes: own.quotes + untagged.quotes,
        contacts: own.contacts + untagged.contacts,
        accounts: own.accounts + untagged.accounts,
      },
      supportedMetrics: METRICS.filter((m) => m.kind === 'crm' && crmMetricSupport(m, capability).supported).map((m) => m.id),
    };
  }

  private async emailSources(organizationId: string): Promise<EmailSourceView[]> {
    const userIds = (
      await this.connection
        .collection('users')
        .find({ organizationId }, { projection: { _id: 1 } })
        .toArray()
    ).map((u) => u._id.toString());
    const views: EmailSourceView[] = [];
    for (const [provider, label, collection] of [
      ['outlook', 'Outlook', 'outlook_connections'],
      ['gmail', 'Gmail', 'gmail_connections'],
    ] as const) {
      const rows = await this.connection
        .collection(collection)
        .find({ userId: { $in: userIds }, isActive: { $ne: false } }, { projection: { status: 1 } })
        .toArray();
      if (rows.length > 0) {
        views.push({
          provider,
          label,
          mailboxes: rows.length,
          needsReconnect: rows.filter((r) => r.status === 'needs_reauth').length,
        });
      }
    }
    return views;
  }

  private metricAvailability(metric: MetricDefinition, selected: DataSourceDocument[], emailSources: EmailSourceView[]): MetricAvailability {
    const base = { id: metric.id, label: metric.label, kind: metric.kind };
    if (metric.kind === 'email') {
      return emailSources.length > 0
        ? {
            ...base,
            status: 'supported',
            sources: emailSources.map((e) => e.label),
          }
        : {
            ...base,
            status: 'no_source',
            sources: [],
            reason: 'No mailbox is connected.',
          };
    }
    if (selected.length === 0)
      return {
        ...base,
        status: 'no_source',
        sources: [],
        reason: 'No CRM is connected.',
      };
    const results = selected.map((s) => ({
      source: s,
      support: crmMetricSupport(metric, this.capabilityOf(s)),
    }));
    const supporting = results.filter((r) => r.support.supported).map((r) => r.source.label);
    if (supporting.length > 0) return { ...base, status: 'supported', sources: supporting };
    const reason = results[0].support.supported ? undefined : results[0].support.reason;
    return {
      ...base,
      status: 'not_supported',
      sources: [],
      reason: selected.length === 1 ? `Not supported by ${selected[0].label}. ${reason ?? ''}`.trim() : 'None of the selected CRMs provide this.',
    };
  }

  /** Everything the app needs to show data honestly for the current request:
   * which sources exist, which one(s) are selected, where each metric comes
   * from and which metrics the selection simply can't provide. */
  async overview(user: JwtPayload, scope: DataSourceScope) {
    const [sources, counts, emailSources, hiddenMetrics] = await Promise.all([
      this.sourcesFor(user.organizationId),
      this.recordCounts(user.organizationId),
      this.emailSources(user.organizationId),
      this.hiddenMetrics(user.sub),
    ]);
    const views = sources.map((s) => this.toView(s, counts));
    // The HaiVE workspace is only worth offering once it holds something (or
    // is the only source) — an empty one is noise in the source picker.
    const visible = views.filter((v) => !v.native || v.isDefault || Object.values(v.recordCounts).some((n) => n > 0) || views.length === 1);
    const selected = sources.filter((s) => scope.sourceIds.includes(s._id.toString()));
    return {
      selection: {
        mode: scope.mode as SelectionMode,
        sourceIds: scope.sourceIds,
      },
      sources: visible,
      emailSources,
      metrics: METRICS.map((m) => this.metricAvailability(m, selected, emailSources)),
      hiddenMetrics,
      // Unified reporting only means something with two or more connected sources.
      unifiedAvailable: visible.filter((v) => v.status === 'active').length > 1,
    };
  }

  async listForAdmin(organizationId: string) {
    const [sources, counts] = await Promise.all([this.sourcesFor(organizationId), this.recordCounts(organizationId)]);
    return sources.map((s) => ({
      ...this.toView(s, counts),
      integrationProvider: s.integrationProvider,
      connectionId: s.connectionId,
      fieldMappings: s.fieldMappings ?? {},
      statusMapping: s.statusMapping ?? { won: [], lost: [] },
      stageMappings: s.stageMappings ?? [],
      availableFields: s.availableFields ?? {},
      // The webhook key's hash stays server-side; admins see where records go instead.
      metadata: Object.fromEntries(Object.entries(s.metadata ?? {}).filter(([k]) => !k.startsWith('webhookKey'))),
      webhook: s.provider === WEBHOOK_PROVIDER ? webhookInfo(s, this.webhookBaseUrl) : undefined,
      defaults: {
        fieldMappings: (CRM_PROVIDERS[s.provider] ?? CRM_PROVIDERS.custom).fieldMappings,
        statusMapping: (CRM_PROVIDERS[s.provider] ?? CRM_PROVIDERS.custom).statusMapping,
      },
    }));
  }

  catalog() {
    return {
      providers: Object.values(CRM_PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        modules: p.modules,
        syncSupported: p.syncSupported,
      })),
      modules: CRM_MODULES,
      canonicalFields: CANONICAL_FIELDS,
      metrics: METRICS,
    };
  }

  // ---- admin changes -----------------------------------------------------------

  private async getOwned(organizationId: string, id: string): Promise<DataSourceDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Data source not found.');
    const source = await this.sourceModel.findOne({ _id: id, organizationId }).exec();
    if (!source) throw new NotFoundException('Data source not found.');
    return source;
  }

  private sanitizeMappings(input: Record<string, unknown>): FieldMappings {
    const out: FieldMappings = {};
    for (const module of Object.keys(CANONICAL_FIELDS) as MirroredModule[]) {
      const raw = input[module];
      if (!raw || typeof raw !== 'object') continue;
      const allowed = new Set(CANONICAL_FIELDS[module].map((f) => f.key));
      const entries: Record<string, string> = {};
      for (const [field, path] of Object.entries(raw as Record<string, unknown>)) {
        if (!allowed.has(field)) throw new BadRequestException(`“${field}” is not a ${module} field HaiVE knows.`);
        const value = String(path ?? '').trim();
        if (!value) continue; // unmapped
        if (value.length > 200 || !FIELD_PATH.test(value)) {
          throw new BadRequestException(`“${value}” is not a valid field name (use letters, digits, _ and dots, e.g. properties.amount).`);
        }
        entries[field] = value;
      }
      out[module] = entries;
    }
    return out;
  }

  async update(organizationId: string, id: string, dto: UpdateDataSourceDto) {
    const source = await this.getOwned(organizationId, id);
    const set: Record<string, unknown> = {};
    if (dto.label !== undefined) {
      const label = dto.label.trim();
      if (!label) throw new BadRequestException('Give the data source a name.');
      set.label = label.slice(0, 60);
    }
    if (dto.modules !== undefined) set.modules = dto.modules.filter((m) => CRM_MODULES.includes(m));
    if (dto.terminology !== undefined) {
      set.terminology = Object.fromEntries(
        (['deal', 'quote', 'contact', 'account'] as const).map((k) => [
          k,
          String(dto.terminology?.[k] ?? '')
            .trim()
            .slice(0, 40) || CRM_PROVIDERS.haive_native.terminology[k],
        ]),
      );
    }
    if (dto.fieldMappings !== undefined) {
      if (source.key === NATIVE_KEY) throw new BadRequestException('Records created in HaiVE are already in HaiVE’s format — there is nothing to map.');
      set.fieldMappings = this.sanitizeMappings(dto.fieldMappings);
    }
    if (dto.statusMapping !== undefined) {
      set.statusMapping = {
        won: cleanStrings(dto.statusMapping.won),
        lost: cleanStrings(dto.statusMapping.lost),
      };
    }
    if (dto.stageMappings !== undefined) {
      set.stageMappings = dto.stageMappings.slice(0, 200).map((s) => ({
        value: String(s.value ?? '')
          .trim()
          .slice(0, 120),
        label: String(s.label ?? s.value ?? '')
          .trim()
          .slice(0, 80),
        category: s.category === 'won' || s.category === 'lost' ? s.category : 'open',
      }));
    }
    if (dto.syncEnabled !== undefined) set['sync.enabled'] = dto.syncEnabled;
    if (dto.syncIntervalMinutes !== undefined) set['sync.intervalMinutes'] = Math.min(Math.max(Math.round(dto.syncIntervalMinutes), 5), 1440);

    if (dto.isDefault === true) {
      if (source.status !== 'active') throw new BadRequestException('A disconnected source can’t be the default.');
      await this.sourceModel.updateMany({ organizationId, _id: { $ne: source._id } }, { $set: { isDefault: false } }).exec();
      set.isDefault = true;
    }
    // What a record means changed — incremental CRMs must re-read everything,
    // not just what changed since the last sync.
    const remap = dto.fieldMappings !== undefined || dto.statusMapping !== undefined || dto.modules !== undefined;
    if (Object.keys(set).length) {
      await this.sourceModel.updateOne({ _id: source._id }, { $set: set, ...(remap ? { $unset: { 'sync.cursor': '' } } : {}) }).exec();
    }
    this.cache.delete(organizationId);
    return (await this.listForAdmin(organizationId)).find((s) => s.id === id);
  }

  /** Runs the organization's CRM sync now (python-agent pulls each connected
   * source through its adapter and field mappings). */
  async syncNow(organizationId: string, id: string) {
    const source = await this.getOwned(organizationId, id);
    const provider = CRM_PROVIDERS[source.provider] ?? CRM_PROVIDERS.custom;
    if (!provider.syncSupported) throw new BadRequestException(`${source.label} has nothing to sync.`);
    if (source.status !== 'active') throw new BadRequestException(`${source.label} is disconnected. Reconnect it in Integrations first.`);
    const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '10m' });
    try {
      const { data } = await firstValueFrom(
        this.http.post<Record<string, unknown>>(
          `${this.pythonAgentUrl}/sync/crm/run-for-source`,
          { dataSourceId: id },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 180_000 },
        ),
      );
      return data;
    } finally {
      this.cache.delete(organizationId);
    }
  }

  // ---- per-person dashboard preferences --------------------------------------

  private async hiddenMetrics(userId: string): Promise<string[]> {
    if (!isValidObjectId(userId)) return [];
    const user = await this.connection
      .collection('users')
      .findOne({ _id: new Types.ObjectId(userId) }, { projection: { 'preferences.hiddenDashboardMetrics': 1 } });
    const hidden = (user?.preferences as Record<string, unknown> | undefined)?.hiddenDashboardMetrics;
    return Array.isArray(hidden) ? hidden.map(String) : [];
  }

  async setHiddenMetrics(userId: string, hidden: string[]): Promise<string[]> {
    const known = new Set(METRICS.map((m) => m.id));
    const clean = [...new Set(hidden.filter((h) => known.has(h)))];
    await this.connection.collection('users').updateOne({ _id: new Types.ObjectId(userId) }, { $set: { 'preferences.hiddenDashboardMetrics': clean } });
    return clean;
  }
}
