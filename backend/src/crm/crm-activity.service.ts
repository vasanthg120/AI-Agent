import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { businessDayRange, validTimeZone } from '../common/business-day';
import { CrmActivity, CrmActivityDocument, CrmActivityKind } from './schemas/crm-activity.schema';

type Doc = Record<string, any>;
/** A log row to insert: everything but the key is optional. */
type ActivityRow = Partial<CrmActivity> & Pick<CrmActivity, 'dedupeKey'>;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A quotation is sent once it leaves draft: Hoops sent/viewed/accepted/lost, Pantheras published. Voided never counts. */
export const isSentQuoteStatus = (status: unknown): boolean => typeof status === 'string' && status !== 'draft' && status !== 'voided';

/** The kind a deal's status change is: won, lost, or reopened (back to open). */
export function dealStatusKind(to: unknown): CrmActivityKind | null {
  if (to === 'won') return 'won';
  if (to === 'lost') return 'lost';
  if (to === 'open') return 'reopened';
  return null;
}

/** A quotation's approval change: accepted or rejected. */
export function approvalKind(to: unknown): CrmActivityKind | null {
  if (to === 'approved') return 'accepted';
  if (to === 'rejected') return 'rejected';
  return null;
}

/** Noon, business time, on a date-only day — so a date never slides into the next or previous day. */
export function middayOf(timeZone: string, ymd: string): Date {
  const { start } = businessDayRange(timeZone, ymd, ymd);
  return new Date(start.getTime() + 12 * 3_600_000);
}

const dayKey = (at: Date) => at.toISOString().slice(0, 10);

function customerOf(quote: Doc | undefined): string | undefined {
  const client = (quote?.clientDetails ?? {}) as Doc;
  return text(client.companyName) ?? text(client.contactName);
}

// The CRM activity log (schemas/crm-activity.schema.ts): HaiVE's own deal and
// quotation changes, credited to the person signed in, and a one-time
// backfill of what the CRMs' own dates already say. The CRM sync writes the
// rest (python-agent crm_mongo_sync.py), with the same dedupe keys.
@Injectable()
export class CrmActivityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CrmActivityService.name);

  constructor(
    @InjectModel(CrmActivity.name) private activityModel: Model<CrmActivityDocument>,
    @InjectConnection() private connection: Connection,
  ) {}

  /** Inserted once per dedupeKey — recording the same change again changes nothing. */
  async record(rows: ActivityRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.activityModel.bulkWrite(
      rows.map((row) => ({ updateOne: { filter: { dedupeKey: row.dedupeKey }, update: { $setOnInsert: row }, upsert: true } })),
      { ordered: false },
    );
  }

  // ---- done in HaiVE ---------------------------------------------------------------

  /** A deal created in HaiVE (closed already, if it was created won or lost). */
  async dealCreated(deal: Doc, actorUserId?: string): Promise<void> {
    const id = String(deal._id);
    const at = deal.createdAt instanceof Date ? deal.createdAt : new Date();
    const base = this.dealBase(deal, actorUserId);
    const rows: ActivityRow[] = [{ ...base, kind: 'created' as const, toStatus: deal.dealStatus, occurredAt: at, dedupeKey: `haive:deal:${id}:created` }];
    const closed = dealStatusKind(deal.dealStatus);
    if (closed && closed !== 'reopened') rows.push({ ...base, kind: closed, toStatus: deal.dealStatus, occurredAt: at, dedupeKey: `haive:deal:${id}:${closed}:${at.toISOString()}` });
    await this.record(rows);
  }

  /** A deal's status changed in HaiVE. */
  async dealStatusChanged(deal: Doc, fromStatus: string | undefined, actorUserId?: string): Promise<void> {
    const kind = dealStatusKind(deal.dealStatus);
    if (!kind || fromStatus === deal.dealStatus) return;
    const at = new Date();
    await this.record([
      { ...this.dealBase(deal, actorUserId), kind, fromStatus, toStatus: deal.dealStatus, occurredAt: at, dedupeKey: `haive:deal:${String(deal._id)}:${kind}:${at.toISOString()}` },
    ]);
  }

  /** A quotation written in HaiVE (sent already, if it was saved as anything but a draft); byAi when the AI drafted it. */
  async quoteCreated(quote: Doc, actorUserId?: string, options: { byAi?: boolean } = {}): Promise<void> {
    const id = String(quote._id);
    const at = quote.createdAt instanceof Date ? quote.createdAt : new Date();
    const base = { ...this.quoteBase(quote, actorUserId), byAi: !!options.byAi };
    const rows: ActivityRow[] = [{ ...base, kind: 'created' as const, toStatus: quote.quoteStatus, occurredAt: at, dedupeKey: `haive:quote:${id}:created` }];
    if (isSentQuoteStatus(quote.quoteStatus)) rows.push({ ...base, kind: 'sent', toStatus: quote.quoteStatus, occurredAt: at, dedupeKey: `haive:quote:${id}:sent` });
    await this.record(rows);
  }

  /** A quotation changed in HaiVE: sent for the first time, accepted or rejected. */
  async quoteChanged(before: Doc, after: Doc, actorUserId?: string): Promise<void> {
    const id = String(after._id);
    const at = new Date();
    const base = this.quoteBase(after, actorUserId);
    const rows: ActivityRow[] = [];
    if (!isSentQuoteStatus(before.quoteStatus) && isSentQuoteStatus(after.quoteStatus))
      rows.push({ ...base, kind: 'sent', fromStatus: before.quoteStatus, toStatus: after.quoteStatus, occurredAt: at, dedupeKey: `haive:quote:${id}:sent` });
    const approval = before.clientApprovalStatus !== after.clientApprovalStatus ? approvalKind(after.clientApprovalStatus) : null;
    if (approval)
      rows.push({
        ...base,
        kind: approval,
        fromStatus: before.clientApprovalStatus,
        toStatus: after.clientApprovalStatus,
        occurredAt: at,
        dedupeKey: `haive:quote:${id}:${approval}:${at.toISOString()}`,
      });
    await this.record(rows);
  }

  private dealBase(deal: Doc, actorUserId?: string): Partial<CrmActivity> {
    return {
      organizationId: deal.organizationId,
      dataSourceId: text(deal.dataSourceId),
      provider: text(deal.sourceProvider) ?? 'haive',
      entity: 'deal',
      entityId: String(deal._id),
      externalId: text(deal.externalId),
      ref: text(deal.name),
      value: num(deal.monetaryValue),
      actorUserId,
      crmOwnerRef: text(deal.externalOwnerRef),
      crmOwnerLabel: text(deal.externalOwnerLabel),
      origin: 'haive',
      occurredAtBasis: 'haive',
    };
  }

  private quoteBase(quote: Doc, actorUserId?: string): Partial<CrmActivity> {
    return {
      organizationId: quote.organizationId,
      dataSourceId: text(quote.dataSourceId),
      provider: text(quote.sourceProvider) ?? 'haive',
      entity: 'quote',
      entityId: String(quote._id),
      externalId: text(quote.externalId),
      ref: text(quote.quoteNumber) ?? text(quote.quoteName),
      customerName: customerOf(quote),
      value: num(quote.quoteAmount),
      currency: text(quote.currency),
      dealId: text(quote.dealId),
      actorUserId,
      crmOwnerRef: text(quote.quoteOwner),
      crmOwnerLabel: text(quote.quoteOwnerLabel),
      origin: 'haive',
      occurredAtBasis: 'haive',
    };
  }

  // ---- one-time backfill -------------------------------------------------------------

  // Once per database (marker in app_migrations), in the background: the
  // history the stored records can honestly give. Same dedupe keys as the
  // sync, so a sync that already logged something is never doubled.
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.backfillOnce().catch((err: Error) => this.logger.error(`CRM activity backfill failed: ${err.message}`));
  }

  async backfillOnce(): Promise<number> {
    const markers = this.connection.collection('app_migrations');
    const id = 'crm-activities-backfill-v1';
    if (await markers.findOne({ _id: id as never })) return 0;
    let total = 0;
    const orgs = await this.connection.collection('organizations').find({}, { projection: { _id: 1, timezone: 1 } }).toArray();
    for (const org of orgs) total += await this.backfill(org._id.toString(), validTimeZone(org.timezone));
    await markers.updateOne({ _id: id as never }, { $set: { doneAt: new Date(), rows: total } }, { upsert: true });
    this.logger.log(`CRM activity backfill: ${total} rows`);
    return total;
  }

  /**
   * One organization's history from its stored deals and quotations:
   *  - created: when the CRM gives a creation date (Hoops, Gorilla Dash quotes and deals,
   *    Pantheras quotes; never Pantheras deals, whose creation date is only the import's);
   *  - won / lost: when closedAt recorded it, else on the closing date (the Dashboard's basis);
   *  - quotation sent: anything not a draft counts as sent when it was created (marked assumed).
   * Acceptance dates are unknown for old quotations and are not invented.
   */
  async backfill(organizationId: string, timeZone: string): Promise<number> {
    const sources = await this.connection
      .collection('crm_data_sources')
      .find({ organizationId }, { projection: { _id: 1, provider: 1, 'fieldMappings.deals.createdAt': 1, 'fieldMappings.quotes.createdAt': 1 } })
      .toArray();
    const sourceById = new Map(sources.map((s) => [s._id.toString(), s]));
    const hasCrmDate = (dataSourceId: unknown, module: 'deals' | 'quotes') => {
      const source = typeof dataSourceId === 'string' ? sourceById.get(dataSourceId) : undefined;
      if (!source || source.provider === 'haive_native') return true; // written in HaiVE: its createdAt is real
      return !!(source.fieldMappings as Doc | undefined)?.[module]?.createdAt;
    };
    const keyPrefix = (doc: Doc, entity: 'deal' | 'quote') =>
      doc.externalId && doc.dataSourceId ? `${doc.dataSourceId}:${entity}:${doc.externalId}` : `haive:${entity}:${String(doc._id)}`;

    const rows: ActivityRow[] = [];
    const deals = await this.connection
      .collection('crm_deals')
      .find(
        { organizationId },
        { projection: { name: 1, dealStatus: 1, monetaryValue: 1, expectedClosingDate: 1, closedAt: 1, createdAt: 1, dataSourceId: 1, sourceProvider: 1, externalId: 1, externalOwnerRef: 1, externalOwnerLabel: 1 } },
      )
      .toArray();
    for (const deal of deals) {
      // organizationId set here: the projection above does not read it back.
      const base = { ...this.dealBase(deal, undefined), organizationId, origin: 'backfill' as const };
      const prefix = keyPrefix(deal, 'deal');
      if (deal.createdAt instanceof Date && hasCrmDate(deal.dataSourceId, 'deals'))
        rows.push({ ...base, kind: 'created', occurredAt: deal.createdAt, occurredAtBasis: deal.dataSourceId && deal.externalId ? 'crm' : 'haive', dedupeKey: `${prefix}:created` });
      const closed = dealStatusKind(deal.dealStatus);
      if (closed === 'won' || closed === 'lost') {
        const closing = text(deal.expectedClosingDate)?.slice(0, 10);
        const at = deal.closedAt instanceof Date ? deal.closedAt : closing && /^\d{4}-\d{2}-\d{2}$/.test(closing) ? middayOf(timeZone, closing) : undefined;
        if (at)
          rows.push({
            ...base,
            kind: closed,
            toStatus: deal.dealStatus,
            occurredAt: at,
            occurredAtBasis: deal.closedAt instanceof Date ? 'detected' : 'closing_date',
            dedupeKey: `${prefix}:${closed}:${dayKey(at)}`,
          });
      }
    }

    const quotes = await this.connection
      .collection('crm_quotes')
      .find(
        { organizationId },
        {
          projection: {
            quoteNumber: 1,
            quoteName: 1,
            quoteStatus: 1,
            quoteAmount: 1,
            currency: 1,
            clientDetails: 1,
            dealId: 1,
            createdAt: 1,
            dataSourceId: 1,
            sourceProvider: 1,
            externalId: 1,
            quoteOwner: 1,
            quoteOwnerLabel: 1,
            ownerUserId: 1,
          },
        },
      )
      .toArray();
    for (const quote of quotes) {
      if (!(quote.createdAt instanceof Date) || !hasCrmDate(quote.dataSourceId, 'quotes')) continue;
      const native = !(quote.dataSourceId && quote.externalId);
      const base = { ...this.quoteBase(quote, native ? text(quote.ownerUserId) : undefined), organizationId, origin: 'backfill' as const };
      const prefix = keyPrefix(quote, 'quote');
      rows.push({ ...base, kind: 'created', occurredAt: quote.createdAt, occurredAtBasis: native ? 'haive' : 'crm', dedupeKey: `${prefix}:created` });
      if (isSentQuoteStatus(quote.quoteStatus))
        rows.push({ ...base, kind: 'sent', toStatus: quote.quoteStatus, occurredAt: quote.createdAt, occurredAtBasis: 'assumed', dedupeKey: `${prefix}:sent` });
    }

    for (let i = 0; i < rows.length; i += 500) await this.record(rows.slice(i, i + 500));
    return rows.length;
  }
}
