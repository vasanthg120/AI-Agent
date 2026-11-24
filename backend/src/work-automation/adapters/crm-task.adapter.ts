import { Injectable } from '@nestjs/common';
import { IdentityService } from '../identity.service';
import { AutomationConfigValues, SourceTask, TaskPriority } from '../task-types';
import { addDays, CollectContext, dateOnlyDeadline, CollectResult, MAX_SOURCE_ROWS, platformLabel, RecordReader, TaskSourceAdapter } from './task-source-adapter';

const DAY_MS = 24 * 60 * 60 * 1000;
// How long a closed record is still reported, so a sync that runs a day late
// still records its completion with evidence.
const CLOSED_LOOKBACK_DAYS = 3;
// Quote statuses that mean the quote is not a live receivable.
const DEAD_QUOTE_STATUSES = new Set(['draft', 'cancelled', 'canceled', 'void', 'voided', 'rejected', 'lost', 'expired']);

/** A CRM date-only deadline as the end of that day in the organization's timezone (see dateOnlyDeadline). */
export const dueFromDateString = dateOnlyDeadline;

export interface DealLike {
  name?: string;
  expectedClosingDate?: unknown;
  lastActivityAt?: Date;
  updatedAt?: Date;
  monetaryValue?: number;
}

/**
 * Whether an open deal is genuinely actionable today, and why. A deal that is
 * simply open and quiet is NOT a task: it needs a closing date inside the
 * window (or past it), or to have gone untouched for staleDealDays.
 */
export function dealActionability(deal: DealLike, now: Date, cfg: Pick<AutomationConfigValues, 'staleDealDays' | 'dealCloseWindowDays'>, timezone: string):
  | { reason: 'overdue_close' | 'closing_soon' | 'stale'; title: string; priority: TaskPriority; dueDate?: Date; detail: string }
  | null {
  const name = (deal.name ?? 'Untitled deal').toString();
  const due = dueFromDateString(deal.expectedClosingDate, timezone);
  if (due) {
    const daysLeft = Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
    if (due.getTime() < now.getTime()) {
      return { reason: 'overdue_close', title: `Update or close deal: ${name}`, priority: 'high', dueDate: due, detail: `Expected closing date ${String(deal.expectedClosingDate).slice(0, 10)} has passed.` };
    }
    if (daysLeft <= cfg.dealCloseWindowDays) {
      return { reason: 'closing_soon', title: `Close deal: ${name}`, priority: daysLeft <= 2 ? 'high' : 'medium', dueDate: due, detail: `Expected to close on ${String(deal.expectedClosingDate).slice(0, 10)}.` };
    }
  }
  const touched = deal.lastActivityAt ?? deal.updatedAt;
  if (touched) {
    const idleDays = Math.floor((now.getTime() - new Date(touched).getTime()) / DAY_MS);
    if (idleDays >= cfg.staleDealDays) {
      return { reason: 'stale', title: `Follow up on deal: ${name}`, priority: 'medium', detail: `No activity for ${idleDays} days.` };
    }
  }
  return null;
}

/** Remaining balance of a quote, never negative. */
export function quoteBalance(quote: { quoteAmount?: number; paidAmount?: number }): number {
  return Math.max(0, (quote.quoteAmount ?? 0) - (quote.paidAmount ?? 0));
}

/**
 * Deals and quotes of the connected CRMs (Pantheras and Hoops by default; the
 * set is the organization's crmProviders setting). Ownership comes from the
 * existing Deal.ownerId / Quote.ownerUserId, which are set only by verified
 * mappings (Settings → Deal Assignment). Deals still carrying only a raw CRM
 * owner reference go through IdentityService: matched by verified email, else
 * recorded as unresolved for an admin — never matched on a name.
 */
@Injectable()
export class CrmTaskAdapter implements TaskSourceAdapter {
  readonly id = 'crm';
  readonly label = 'CRM deals & quotes';
  readonly sourceTypes = ['deal', 'quote_payment'] as const;
  readonly description =
    'Open deals that are near or past their closing date or have gone quiet, and quote payments that are due, for deals/quotes owned by the employee (Pantheras, Hoops).';

  constructor(
    private reader: RecordReader,
    private identities: IdentityService,
  ) {}

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const providers = ctx.config.crmProviders;
    if (providers.length === 0) return { tasks: [], complete: true, unresolved: 0 };
    const tasks: SourceTask[] = [];
    let unresolved = 0;
    let complete = true;

    // ---- deals ----
    const base: Record<string, unknown> = { organizationId: ctx.organizationId, sourceProvider: { $in: providers } };
    const closedSince = new Date(ctx.now.getTime() - CLOSED_LOOKBACK_DAYS * DAY_MS);
    const statusClause = { $or: [{ dealStatus: 'open' }, { dealStatus: { $in: ['won', 'lost'] }, updatedAt: { $gte: closedSince } }] };
    // For one employee: their own deals, plus deals with no verified owner (which may resolve to them through the identity map).
    const ownerClause = ctx.userId ? { $or: [{ ownerId: ctx.userId }, { ownerId: { $in: [null, ''] } }] } : {};
    const deals = await this.reader.find('crm_deals', { ...base, $and: [statusClause, ownerClause] }, { limit: MAX_SOURCE_ROWS, sort: { updatedAt: -1 } });
    if (deals.length >= MAX_SOURCE_ROWS) complete = false;

    const resolved = new Map<string, string | null>();
    const countedUnresolved = new Set<string>();
    const ownerOf = async (deal: Record<string, any>): Promise<string | null> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (deal.ownerId) return String(deal.ownerId);
      const ref = typeof deal.externalOwnerRef === 'string' ? deal.externalOwnerRef.trim() : '';
      if (!ref) return null;
      const platform = platformLabel(deal.sourceProvider);
      const cacheKey = `${platform}|${ref}`;
      if (!resolved.has(cacheKey)) {
        const label = typeof deal.externalOwnerLabel === 'string' ? deal.externalOwnerLabel : undefined;
        resolved.set(cacheKey, await this.identities.resolve(ctx.organizationId, platform, { externalUserId: ref, email: label?.includes('@') ? label : undefined, displayName: label }));
      }
      const userId = resolved.get(cacheKey) ?? null;
      if (!userId && !countedUnresolved.has(cacheKey)) {
        countedUnresolved.add(cacheKey);
        unresolved += 1;
      }
      return userId;
    };

    for (const deal of deals) {
      const owner = await ownerOf(deal);
      if (!owner || (ctx.userId && owner !== ctx.userId)) continue;
      const platform = platformLabel(deal.sourceProvider);
      const common = { sourcePlatform: platform, sourceType: 'deal', sourceRecordId: String(deal._id), assignedTo: owner, sourceUrl: '/customers', sourceUpdatedAt: deal.updatedAt ? new Date(deal.updatedAt) : undefined };
      if (deal.dealStatus === 'open') {
        const verdict = dealActionability(deal, ctx.now, ctx.config, ctx.timezone);
        if (!verdict) continue;
        tasks.push({ ...common, title: verdict.title, description: verdict.detail, priority: verdict.priority, dueDate: verdict.dueDate, sourceStatus: 'open', state: 'open' });
      } else if (deal.dealStatus === 'won') {
        const at = new Date(deal.closedAt ?? deal.updatedAt ?? ctx.now);
        tasks.push({ ...common, title: `Deal: ${deal.name ?? ''}`, priority: 'medium', sourceStatus: 'won', state: 'closed', closure: { kind: 'completed', evidence: { type: 'source_status', detail: `Deal marked won in ${platform}.`, at, sourceRef: String(deal._id) } } });
      } else {
        tasks.push({ ...common, title: `Deal: ${deal.name ?? ''}`, priority: 'medium', sourceStatus: 'lost', state: 'closed', closure: { kind: 'withdrawn', reason: `Deal marked lost in ${platform}.` } });
      }
    }

    // ---- quote payments ----
    const quoteFilter: Record<string, unknown> = { ...base, ownerUserId: ctx.userId ?? { $exists: true } };
    const quotes = await this.reader.find('crm_quotes', quoteFilter, { limit: MAX_SOURCE_ROWS, sort: { updatedAt: -1 } });
    if (quotes.length >= MAX_SOURCE_ROWS) complete = false;
    const window = addDays(ctx.now, ctx.config.quoteDueWindowDays);
    for (const quote of quotes) {
      if (!quote.ownerUserId) continue;
      const platform = platformLabel(quote.sourceProvider);
      const balance = quoteBalance(quote);
      const label = quote.quoteNumber ? `#${quote.quoteNumber}` : (quote.quoteName ?? 'quote');
      const common = { sourcePlatform: platform, sourceType: 'quote_payment', sourceRecordId: String(quote._id), assignedTo: String(quote.ownerUserId), sourceUrl: '/customers', sourceUpdatedAt: quote.updatedAt ? new Date(quote.updatedAt) : undefined };
      const dead = DEAD_QUOTE_STATUSES.has(String(quote.quoteStatus ?? '').toLowerCase());
      const due = dueFromDateString(quote.dueDate, ctx.timezone);
      if (!dead && balance > 0 && due && due.getTime() <= window.getTime()) {
        const late = due.getTime() < ctx.now.getTime();
        tasks.push({
          ...common,
          title: `Collect payment: quote ${label}`,
          description: `Balance ${balance} ${quote.currency ?? ''} of ${quote.quoteAmount ?? 0} due ${String(quote.dueDate).slice(0, 10)}.`.replace(/\s+\./, '.'),
          priority: late ? 'high' : 'medium',
          dueDate: due,
          sourceStatus: String(quote.paymentStatus ?? quote.quoteStatus ?? ''),
          state: 'open',
        });
      } else if (balance === 0 && (quote.paidAmount ?? 0) > 0 && quote.updatedAt && new Date(quote.updatedAt) >= closedSince) {
        tasks.push({
          ...common,
          title: `Collect payment: quote ${label}`,
          priority: 'medium',
          sourceStatus: 'paid',
          state: 'closed',
          closure: { kind: 'completed', evidence: { type: 'source_event', detail: `Payment recorded: ${quote.paidAmount} of ${quote.quoteAmount} received.`, at: new Date(quote.updatedAt), sourceRef: String(quote._id) } },
        });
      }
    }

    return { tasks, complete, unresolved };
  }
}
