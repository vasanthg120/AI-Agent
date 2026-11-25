import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { currentDataSourceScope } from '../data-sources/data-source-context';
import { businessTimeZone } from '../common/business-day';
import { countedDayOf, countedInMonths } from '../crm/deal-filter.util';
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
// target and never added to it. Two dates, kept apart:
//
//  - Closed — the day the deal was won, which is also the month its revenue
//    counts in (SalesAnalyticsService.getAchievement's rule since 2026-11-25,
//    countedDayExpr in deal-filter.util.ts): Deal.closedAt in the business's
//    time zone; for a deal closed before that was recorded, its closing date.
//    So every deal listed is in this month's revenue (revenuePeriod = period;
//    until 2026-11-25 revenue went by the expected closing date, and a deal
//    could be listed here while its revenue sat in another month).
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
// once the same deal kept in both counts once (name, value and closing day).
@Injectable()
export class PreviousMonthClosuresService {
  constructor(
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectConnection() private connection: Connection,
  ) {}

  async get(organizationId: string, scope: ScopeInfo, period: string): Promise<PreviousMonthClosures> {
    const previous = previousPeriod(period);
    const timeZone = await businessTimeZone(this.connection, organizationId);

    const deals = await this.dealModel
      .find({
        organizationId,
        dealStatus: 'won',
        ...(scope.level === 'store' && scope.storeId ? { storeId: scope.storeId } : {}),
        ...(scope.level === 'user' && scope.userId ? { ownerId: scope.userId } : {}),
        // Won in this month — the deals in this month's revenue.
        ...countedInMonths(period, period, timeZone),
      })
      .select({ name: 1, dealStatus: 1, monetaryValue: 1, expectedClosingDate: 1, closedAt: 1, createdAt: 1, dataSourceId: 1 })
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
      // The query matched it on this day, so there is one.
      const closedOn = countedDayOf(d, timeZone)!;
      return {
        key: `${d.name.trim().toLowerCase()}|${d.monetaryValue}|${closedOn}`,
        id,
        name: d.name.trim(),
        value: d.monetaryValue ?? 0,
        started: earliest?.real ? { on: day(earliest.date), from: earliest.from } : null,
        closedOn,
        closedFrom: d.closedAt ? 'recorded' : 'closing-date',
        revenuePeriod: closedOn.slice(0, 7),
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
