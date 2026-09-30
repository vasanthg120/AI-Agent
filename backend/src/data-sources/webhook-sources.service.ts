import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Connection, Model, isValidObjectId } from 'mongoose';
import { RawRecord, cleanKeys, fieldPaths, guessMappings, mapStatus, parseDate, toCanonical, toDay, toNumber, withDisplayName } from './canonical-mapping';
import { DataSourcesService } from './data-sources.service';
import { CRM_PROVIDERS, MirroredModule, Terminology } from './provider-catalog';
import { DataSource, DataSourceDocument } from './schemas/data-source.schema';
import { WEBHOOK_MODULES, WEBHOOK_PROVIDER, webhookInfo } from './webhook-info';

const COLLECTION: Record<string, string> = {
  deals: 'crm_deals',
  contacts: 'crm_contacts',
  accounts: 'crm_accounts',
};
const MAX_RECORDS = 100;
const MAX_FIELDS = 500;

export interface IngestResult {
  source: string;
  module: string;
  received: number;
  stored: number;
  skipped: number;
  problems: string[];
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

// Data sources fed by pushes rather than a sync: each app in an organization's
// Zapier account (Hoops, …) gets its own source and its own secret webhook
// address; a Zap ("New Customer in Hoops" -> "Webhooks by Zapier: POST")
// sends every new record there. Records are mapped with the source's own field
// mappings and stored under that source only — exactly like synced CRMs, so
// dashboards, the source picker and the AI tools treat them the same way.
//
// The webhook key is the only credential: generated here, shown to the
// administrator once, stored only as a SHA-256 hash, and it identifies one
// source of one organization — a request can never write anywhere else.
@Injectable()
export class WebhookSourcesService {
  private readonly logger = new Logger(WebhookSourcesService.name);
  private readonly baseUrl: string;

  constructor(
    @InjectModel(DataSource.name)
    private sourceModel: Model<DataSourceDocument>,
    @InjectConnection() private connection: Connection,
    private dataSources: DataSourcesService,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('dataSources.webhookBaseUrl') ?? '';
  }

  private newKey(): { key: string; hash: string; hint: string } {
    const key = `hvk_${randomBytes(24).toString('base64url')}`;
    return {
      key,
      hash: hashKey(key),
      hint: `${key.slice(0, 6)}…${key.slice(-4)}`,
    };
  }

  private slug(label: string): string {
    return (
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30) || 'app'
    );
  }

  private async owned(organizationId: string, id: string): Promise<DataSourceDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Data source not found.');
    const source = await this.sourceModel.findOne({ _id: id, organizationId, provider: WEBHOOK_PROVIDER }).exec();
    if (!source) throw new NotFoundException('Data source not found.');
    return source;
  }

  /** A new webhook source ("Hoops"). Returns the webhook key — the only time it's shown. */
  async create(
    organizationId: string,
    input: {
      label: string;
      modules?: MirroredModule[];
      terminology?: Partial<Terminology>;
    },
  ) {
    const label = input.label.trim().slice(0, 60);
    if (!label) throw new BadRequestException('Give the source a name, e.g. the app it comes from (“Hoops”).');
    const existing = await this.sourceModel.find({ organizationId }, { key: 1, label: 1 }).exec();
    if (existing.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
      throw new BadRequestException(`There is already a data source called “${label}”. Pick another name.`);
    }
    const keys = new Set(existing.map((s) => s.key));
    let key = `zapier-${this.slug(label)}`;
    for (let n = 2; keys.has(key); n++) key = `zapier-${this.slug(label)}-${n}`;

    const provider = CRM_PROVIDERS.zapier;
    const modules = (input.modules?.length ? input.modules : provider.modules).filter((m): m is MirroredModule =>
      WEBHOOK_MODULES.includes(m as MirroredModule),
    );
    if (modules.length === 0) throw new BadRequestException('Pick at least one kind of record to receive.');
    const terms = Object.fromEntries(
      (['deal', 'quote', 'contact', 'account'] as const).map((k) => [k, (input.terminology?.[k] ?? '').trim().slice(0, 40) || provider.terminology[k]]),
    ) as unknown as Terminology;
    const secret = this.newKey();
    const source = await this.sourceModel.create({
      organizationId,
      key,
      provider: provider.id,
      label,
      status: 'active',
      isDefault: false,
      modules,
      terminology: terms,
      fieldMappings: {},
      statusMapping: provider.statusMapping,
      stageMappings: [],
      availableFields: {},
      sync: { enabled: false, intervalMinutes: 10, lastStatus: 'never' },
      metadata: {
        webhookKeyHash: secret.hash,
        webhookKeyHint: secret.hint,
        webhookReceived: 0,
      },
    });
    await this.dataSources.reconcile(organizationId);
    this.logger.log(`Webhook data source "${label}" created for org ${organizationId}`);
    return {
      id: source._id.toString(),
      key: secret.key,
      webhook: webhookInfo(source, this.baseUrl),
    };
  }

  /** A new key; the old one stops working immediately. */
  async rotateKey(organizationId: string, id: string) {
    const source = await this.owned(organizationId, id);
    const secret = this.newKey();
    await this.sourceModel
      .updateOne(
        { _id: source._id },
        {
          $set: {
            'metadata.webhookKeyHash': secret.hash,
            'metadata.webhookKeyHint': secret.hint,
            status: 'active',
          },
        },
      )
      .exec();
    await this.dataSources.reconcile(organizationId);
    return {
      id,
      key: secret.key,
      webhook: webhookInfo(
        {
          ...source.toObject(),
          metadata: { ...source.metadata, webhookKeyHint: secret.hint },
        },
        this.baseUrl,
      ),
    };
  }

  /** Stops accepting records. What was received stays, as a disconnected source's history. */
  async disconnect(organizationId: string, id: string) {
    const source = await this.owned(organizationId, id);
    await this.sourceModel
      .updateOne(
        { _id: source._id },
        {
          $set: { status: 'disconnected', isDefault: false },
          $unset: {
            'metadata.webhookKeyHash': '',
            'metadata.webhookKeyHint': '',
          },
        },
      )
      .exec();
    await this.dataSources.reconcile(organizationId);
    return { id, status: 'disconnected' };
  }

  // ---- ingestion (public, key-authenticated) ------------------------------------

  private async authenticate(id: string, key: string | undefined): Promise<DataSourceDocument> {
    // One answer for "no such source" and "wrong key": nothing to probe.
    const refuse = () => new ForbiddenException('Unknown webhook address or key.');
    if (!key || !isValidObjectId(id)) throw refuse();
    const source = await this.sourceModel.findOne({ _id: id, provider: WEBHOOK_PROVIDER }).exec();
    const stored = (source?.metadata as Record<string, unknown> | undefined)?.webhookKeyHash;
    if (!source || typeof stored !== 'string' || !sameHash(stored, hashKey(key))) throw refuse();
    if (source.status !== 'active') throw new ForbiddenException(`${source.label} is disconnected in HaiVE. Reconnect it in Settings → Data Sources.`);
    return source;
  }

  private records(body: unknown): RawRecord[] {
    // A record, a list of records, or {records|data|items: [...]}.
    let list: unknown = body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const wrapped = ['records', 'data', 'items'].map((k) => (body as RawRecord)[k]).find(Array.isArray);
      list = wrapped ?? [body];
    }
    if (!Array.isArray(list)) throw new BadRequestException('Send a JSON object (one record) or an array of records.');
    const records = list.filter((r): r is RawRecord => !!r && typeof r === 'object' && !Array.isArray(r));
    if (records.length === 0) throw new BadRequestException('No records in the request body.');
    if (records.length > MAX_RECORDS) throw new BadRequestException(`At most ${MAX_RECORDS} records per request.`);
    return records.map((r) => withDisplayName(cleanKeys(r)));
  }

  private async defaultStoreId(organizationId: string): Promise<string | undefined> {
    const stores = await this.connection
      .collection('stores')
      .find({ organizationId }, { projection: { _id: 1 } })
      .limit(2)
      .toArray();
    return stores.length === 1 ? stores[0]._id.toString() : undefined;
  }

  async ingest(id: string, module: string, key: string | undefined, body: unknown): Promise<IngestResult> {
    const source = await this.authenticate(id, key);
    if (!WEBHOOK_MODULES.includes(module as MirroredModule)) {
      throw new BadRequestException(`Unknown record type “${module}”. Use one of: ${WEBHOOK_MODULES.join(', ')}.`);
    }
    const mod = module as MirroredModule;
    if (!(source.modules ?? []).includes(mod)) {
      throw new BadRequestException(`${source.label} isn’t set up to receive ${mod}. Turn it on in Settings → Data Sources.`);
    }
    const records = this.records(body);
    const organizationId = source.organizationId;
    const sourceId = source._id.toString();

    // The first record decides the starting mapping, unless an administrator already set one.
    let mapping = source.fieldMappings?.[mod] ?? {};
    const set: Record<string, unknown> = {};
    if (!mapping.externalId) {
      const guessed = guessMappings(mod, records[0]);
      if (guessed.externalId) {
        mapping = { ...guessed, ...mapping };
        set[`fieldMappings.${mod}`] = mapping;
      }
    }

    const collection = this.connection.collection(COLLECTION[mod]);
    const storeId = mod === 'deals' ? await this.defaultStoreId(organizationId) : undefined;
    const now = new Date();
    const problems: string[] = [];
    let stored = 0;
    for (const raw of records) {
      const c = toCanonical(raw, mapping);
      const externalId = c.externalId === undefined || c.externalId === null || c.externalId === '' ? '' : String(c.externalId);
      if (!externalId) {
        if (problems.length < 5)
          problems.push(
            mapping.externalId
              ? `A record had no “${mapping.externalId}” (its ID field) and was skipped.`
              : 'Records need an ID field (e.g. “id”) so HaiVE can tell them apart — add one to the Zap’s data.',
          );
        continue;
      }
      const filter = { organizationId, dataSourceId: sourceId, externalId };
      let fields: Record<string, unknown>;
      if (mod === 'deals') {
        fields = {
          name: String(c.name ?? '').trim() || 'Untitled deal',
          dealStatus: mapStatus(c.status, source.statusMapping),
          monetaryValue: toNumber(c.amount),
          expectedClosingDate: toDay(c.closeDate),
          stageId: c.stage !== undefined && c.stage !== null ? String(c.stage) : null,
          pipelineId: c.pipeline !== undefined && c.pipeline !== null ? String(c.pipeline) : null,
          lastActivityAt: now,
          ...(storeId ? { storeId } : {}),
          ...(c.owner
            ? {
                externalOwnerRef: String(c.owner),
                externalOwnerProvider: source.provider,
              }
            : {}),
        };
      } else {
        fields = Object.fromEntries(
          Object.entries(c).filter(([k, v]) => k !== 'externalId' && k !== 'createdAt' && v !== undefined && v !== null && v !== '' && typeof v !== 'object'),
        );
        if (!fields.name) fields.name = mod === 'contacts' ? (fields.email ?? 'Unnamed contact') : 'Unnamed company';
      }
      await collection.updateOne(
        filter,
        {
          $set: { ...filter, sourceProvider: source.provider, ...fields },
          $setOnInsert: { createdAt: parseDate(c.createdAt) ?? now },
        },
        { upsert: true },
      );
      stored += 1;
    }

    const seen = new Set<string>(source.availableFields?.[mod] ?? []);
    for (const raw of records.slice(0, 20)) for (const path of fieldPaths(raw)) seen.add(path);
    await this.sourceModel
      .updateOne(
        { _id: source._id },
        {
          $set: {
            ...set,
            [`availableFields.${mod}`]: [...seen].sort().slice(0, MAX_FIELDS),
            'sync.lastSyncAt': now,
            'sync.lastStatus': stored > 0 || problems.length === 0 ? 'ok' : 'error',
            'sync.lastCounts': { [mod]: stored },
            'metadata.webhookLastReceivedAt': now,
            ...(stored === 0 && problems.length ? { 'sync.lastError': problems[0] } : {}),
          },
          $inc: { 'metadata.webhookReceived': stored },
          ...(stored > 0 ? { $unset: { 'sync.lastError': '' } } : {}),
        },
      )
      .exec();
    return {
      source: source.label,
      module: mod,
      received: records.length,
      stored,
      skipped: records.length - stored,
      problems,
    };
  }
}
