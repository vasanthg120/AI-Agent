import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { currentDataSourceScope } from '../data-sources/data-source-context';
import { Deal, DealDocument } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument } from '../crm/schemas/quote.schema';
import { PreviousMonthClosedDeal, PreviousMonthClosures, ScopeInfo } from './analytics-dashboard.types';

/** "YYYY-MM" of the month before `period` ("YYYY-MM"). */
export function previousPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

type RecordKind = 'deals' | 'quotes';
type Candidate = { date: Date; from: 'deal' | 'quote'; real: boolean };
type Entry = Omit<PreviousMonthClosedDeal, 'startedOn' | 'startedFrom'> & { key: string; started: { on: string; from: 'deal' | 'quote' } | null };

const day = (d: Date) => d.toISOString().slice(0, 10);
// To the paisa, so a total never shows a float artefact (104261.84999…).
const tally = (rows: { value: number }[]) => ({ count: rows.length, value: Math.round(rows.reduce((sum, r) => sum + r.value, 0) * 100) / 100 });

// "Deals from last month closed this month", shown beside Revenue against
// target and never added to it. Three dates, kept apart:
//
//  - Revenue month — unchanged, SalesAnalyticsService.getAchievement's rule: a
//    won deal counts in the month of its expectedClosingDate (stamped with the
//    day it turned won unless the CRM sent its own date at the same time).
//  - Closed — Deal.closedAt, the moment HaiVE saw the deal turn won; for a deal
//    closed before that was recorded, its closing date (which, by the rule
//    above, is the day it was won whenever HaiVE saw it happen).
//  - Started — the earliest date the deal or one of its quotes was recorded.
//    A deal synced from a CRM that sends no creation date (ProspectConnect's
//    deals) has as createdAt only when HaiVE first saw it; the first import
//    stamps every older deal with the import time, so such a date is not a
//    start. It still proves the deal existed by then: when nothing real comes
//    earlier, the start is unknown, and the deal is reported as such rather
//    than guessed into a month.
//
// A deal reopened is no longer won, so it drops out; one closed twice counts
// once, in the month of its latest closing. In a view of two or more CRMs at
// once the same deal kept in both counts once (same key as the rest of the
// dashboard: name, value, closing date).
@Injectable()
export class PreviousMonthClosuresService {
  constructor(
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectConnection() private connection: Connection,
  ) {}

  async get(organizationId: string, scope: ScopeInfo, period: string): Promise<PreviousMonthClosures> {
    const previous = previousPeriod(period);
    const start = new Date(`${period}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);

    const deals = await this.dealModel
      .find({
        organizationId,
        dealStatus: 'won',
        ...(scope.level === 'store' && scope.storeId ? { storeId: scope.storeId } : {}),
        ...(scope.level === 'user' && scope.userId ? { ownerId: scope.userId } : {}),
        $or: [{ closedAt: { $gte: start, $lt: end } }, { closedAt: null, expectedClosingDate: { $regex: `^${period}` } }],
      })
      .select({ name: 1, monetaryValue: 1, expectedClosingDate: 1, closedAt: 1, createdAt: 1, dataSourceId: 1 })
      .lean()
      .exec();

    const dealIds = deals.map((d) => d._id.toString());
    const quotes = dealIds.length
      ? await this.quoteModel
          .find({ organizationId, dealId: { $in: dealIds } })
          .select({ dealId: 1, createdAt: 1, dataSourceId: 1 })
          .lean()
          .exec()
      : [];
    const isRealCreation = await this.creationDateRule([...deals, ...quotes].map((r) => r.dataSourceId));

    const quoteDates = new Map<string, Candidate[]>();
    for (const q of quotes) {
      if (!q.dealId || !q.createdAt) continue;
      const list = quoteDates.get(q.dealId) ?? [];
      list.push({ date: q.createdAt, from: 'quote', real: isRealCreation('quotes', q.dataSourceId, q.createdAt) });
      quoteDates.set(q.dealId, list);
    }

    let entries: Entry[] = deals.map((d) => {
      const id = d._id.toString();
      const candidates = [...(quoteDates.get(id) ?? [])];
      if (d.createdAt) candidates.push({ date: d.createdAt, from: 'deal', real: isRealCreation('deals', d.dataSourceId, d.createdAt) });
      const earliest = candidates.sort((a, b) => a.date.getTime() - b.date.getTime())[0];
      const closing = /^\d{4}-\d{2}/.test(d.expectedClosingDate ?? '') ? d.expectedClosingDate! : null;
      return {
        key: `${d.name.trim().toLowerCase()}|${d.monetaryValue}|${d.expectedClosingDate ?? ''}`,
        id,
        name: d.name.trim(),
        value: d.monetaryValue ?? 0,
        started: earliest?.real ? { on: day(earliest.date), from: earliest.from } : null,
        closedOn: d.closedAt ? day(d.closedAt) : closing!.slice(0, 10),
        closedFrom: d.closedAt ? 'recorded' : 'closing-date',
        revenuePeriod: closing ? closing.slice(0, 7) : null,
      };
    });

    if ((currentDataSourceScope()?.sourceIds.length ?? 0) >= 2) {
      const byKey = new Map<string, Entry>();
      for (const e of entries) {
        const kept = byKey.get(e.key);
        if (!kept || (e.started && (!kept.started || e.started.on < kept.started.on))) byKey.set(e.key, e);
      }
      entries = [...byKey.values()];
    }

    const listed: PreviousMonthClosedDeal[] = entries
      .filter((e) => e.started?.on.startsWith(previous))
      .map(({ key: _key, started, ...e }) => ({ ...e, startedOn: started!.on, startedFrom: started!.from }))
      .sort((a, b) => b.value - a.value);

    return {
      period,
      previousPeriod: previous,
      ...tally(listed),
      inThisMonthRevenue: tally(listed.filter((d) => d.revenuePeriod === period)),
      outsideThisMonthRevenue: tally(listed.filter((d) => d.revenuePeriod !== period)),
      unknownStart: tally(entries.filter((e) => !e.started)),
      deals: listed,
    };
  }

  // Whether a record's createdAt is when it was really created. Made in HaiVE:
  // yes. From a CRM that sends a creation date for that kind of record: yes (the
  // sync keeps it). Otherwise createdAt is when HaiVE first saw the record — a
  // creation date only for records that appeared after the source's first
  // complete sync.
  private async creationDateRule(
    dataSourceIds: (string | undefined)[],
  ): Promise<(module: RecordKind, dataSourceId: string | undefined, createdAt: Date) => boolean> {
    const ids = [...new Set(dataSourceIds.filter((id): id is string => !!id && Types.ObjectId.isValid(id)))];
    const [sources, firstSyncs] = ids.length
      ? await Promise.all([
          this.connection
            .collection('crm_data_sources')
            .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { projection: { provider: 1, fieldMappings: 1 } })
            .toArray(),
          this.connection
            .collection('crm_sync_runs')
            .aggregate<{ _id: string; until: Date }>([
              { $match: { dataSourceId: { $in: ids }, status: 'ok' } },
              { $group: { _id: '$dataSourceId', until: { $min: '$finishedAt' } } },
            ])
            .toArray(),
        ])
      : [[], []];
    const sourceById = new Map(sources.map((s) => [s._id.toString(), s]));
    const importedUntil = new Map(firstSyncs.map((r) => [r._id, r.until]));

    return (module, dataSourceId, createdAt) => {
      // No source tag: created in HaiVE by a background job.
      if (!dataSourceId) return true;
      const source = sourceById.get(dataSourceId);
      if (!source) return false;
      if (source.provider === 'haive_native' || source.fieldMappings?.[module]?.createdAt) return true;
      const until = importedUntil.get(dataSourceId);
      return !!until && createdAt.getTime() > new Date(until).getTime();
    };
  }
}
