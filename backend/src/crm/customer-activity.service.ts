import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { periodToDateRange } from '../common/period.util';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { TimelineService } from '../timeline/timeline.service';
import { Account, AccountDocument } from './schemas/account.schema';
import { Contact, ContactDocument } from './schemas/contact.schema';
import { Deal, DealDocument } from './schemas/deal.schema';
import { Quote, QuoteDocument } from './schemas/quote.schema';
import {
  CustomerActivitySummary,
  CustomerActivitySummaryDocument,
} from './schemas/customer-activity-summary.schema';
import {
  CustomerActivityPersonalSummary,
  CustomerActivityPersonalSummaryDocument,
} from './schemas/customer-activity-personal-summary.schema';
import {
  BusinessGroup,
  EmailCorrelationContext,
  buildBusinessGroups,
  groupKeyFor,
  normalizeKey,
  quoteGroupKey,
} from './customer-grouping.util';

export interface TodaysEmail {
  id: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  preview: string;
  isRead: boolean;
  importance: string;
  // Graph's thread id — see EmailIntelligenceSyncService's external-reply
  // detection for why this is captured. Optional since regenerate() below
  // reconstructs a TodaysEmail from an already-stored item that predates
  // this field, and never needs it (only analyzeAndCreate's persistence
  // path does).
  conversationId?: string;
}

export interface CorrelatedEmail extends TodaysEmail {
  matchConfidence: 'exact' | 'domain' | 'fuzzy';
  matchedBusinessKey: string;
  matchedBusinessName: string;
}

const FOLLOW_UP_WINDOW_DAYS = 7;

// today's calendar-day boundary in a given IANA timezone — mirrors
// store-settings.service.ts's scheduledInstant() en-CA formatting approach
// for the same "wall-clock day in a specific zone" problem.
function todayBoundary(tz: string): { dateStr: string; start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(`${dateStr}T23:59:59.999Z`);
  return { dateStr, start, end };
}

@Injectable()
export class CustomerActivityService {
  private readonly logger = new Logger(CustomerActivityService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Account.name) private accountModel: Model<AccountDocument>,
    @InjectModel(CustomerActivitySummary.name) private summaryModel: Model<CustomerActivitySummaryDocument>,
    @InjectModel(CustomerActivityPersonalSummary.name)
    private personalSummaryModel: Model<CustomerActivityPersonalSummaryDocument>,
    private organizationsService: OrganizationsService,
    private usersService: UsersService,
    private timelineService: TimelineService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async getOverview(caller: JwtPayload, storeConstraint?: string) {
    const activity = await this.gatherActivity(caller.organizationId, storeConstraint);
    // The overview endpoint is safe to poll (no LLM call) — it never
    // includes prioritization/missedImportantEmails, which only exist once
    // a summary has actually been generated (see getCachedSummary below).
    const summary = await this.getCachedSummary(caller.organizationId, storeConstraint, activity.dateStr);
    return { ...this.toOverviewShape(activity), summary };
  }

  async generateSummary(caller: JwtPayload, storeConstraint: string | undefined, regenerate: boolean) {
    const activity = await this.gatherActivity(caller.organizationId, storeConstraint);

    if (!regenerate) {
      const existing = await this.summaryModel
        .findOne({ organizationId: caller.organizationId, storeId: storeConstraint ?? { $exists: false }, date: activity.dateStr })
        .exec();
      if (existing) {
        return { ...this.toOverviewShape(activity), summary: { ...existing.result, generatedAt: existing.updatedAt }, cached: true };
      }
    }

    const deterministicInput = this.toLlmPayload(activity);
    let result: Record<string, unknown>;
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId: caller.organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<Record<string, unknown>>(`${this.pythonAgentUrl}/customer-activity/analyze`, deterministicInput, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      result = data;
    } catch (err) {
      this.logger.error(`Customer activity LLM analysis failed: ${(err as Error).message}`);
      throw err;
    }

    const saved = await this.summaryModel
      .findOneAndUpdate(
        { organizationId: caller.organizationId, storeId: storeConstraint ?? { $exists: false }, date: activity.dateStr },
        {
          $set: {
            organizationId: caller.organizationId,
            storeId: storeConstraint,
            date: activity.dateStr,
            requestedByUserId: caller.sub,
            deterministicInput,
            result,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.timelineService.record({
      organizationId: caller.organizationId,
      storeId: storeConstraint,
      userId: caller.sub,
      type: 'customer_activity_summary_generated',
      title: "AI summary generated for today's customer activity",
      sourceType: 'customer_activity',
      sourceId: saved._id.toString(),
    });

    return { ...this.toOverviewShape(activity), summary: { ...result, generatedAt: saved.updatedAt }, cached: false };
  }

  // Consultant-only, self-scoped via caller.sub — no owner/admin override to
  // view a specific consultant's feed exists (matches
  // business-dashboard.service.ts's getConsultantOverview precedent).
  async getPersonalOverview(caller: JwtPayload) {
    const activity = await this.gatherActivity(caller.organizationId, undefined, caller.sub, caller.storeId);
    const summary = await this.getCachedPersonalSummary(caller.organizationId, caller.sub, activity.dateStr);
    return { ...this.toOverviewShape(activity), summary };
  }

  async generatePersonalSummary(caller: JwtPayload, regenerate: boolean) {
    const activity = await this.gatherActivity(caller.organizationId, undefined, caller.sub, caller.storeId);

    if (!regenerate) {
      const existing = await this.personalSummaryModel
        .findOne({ organizationId: caller.organizationId, userId: caller.sub, date: activity.dateStr })
        .exec();
      if (existing) {
        return { ...this.toOverviewShape(activity), summary: { ...existing.result, generatedAt: existing.updatedAt }, cached: true };
      }
    }

    const deterministicInput = this.toLlmPayload(activity);
    let result: Record<string, unknown>;
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId: caller.organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<Record<string, unknown>>(`${this.pythonAgentUrl}/customer-activity/analyze`, deterministicInput, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      result = data;
    } catch (err) {
      this.logger.error(`Personal customer activity LLM analysis failed: ${(err as Error).message}`);
      throw err;
    }

    const saved = await this.personalSummaryModel
      .findOneAndUpdate(
        { organizationId: caller.organizationId, userId: caller.sub, date: activity.dateStr },
        {
          $set: {
            organizationId: caller.organizationId,
            userId: caller.sub,
            date: activity.dateStr,
            requestedByUserId: caller.sub,
            deterministicInput,
            result,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.timelineService.record({
      organizationId: caller.organizationId,
      storeId: caller.storeId,
      userId: caller.sub,
      type: 'customer_activity_personal_summary_generated',
      title: "AI summary generated for your customer activity",
      sourceType: 'customer_activity',
      sourceId: saved._id.toString(),
    });

    return { ...this.toOverviewShape(activity), summary: { ...result, generatedAt: saved.updatedAt }, cached: false };
  }

  private async getCachedSummary(organizationId: string, storeConstraint: string | undefined, dateStr: string) {
    const doc = await this.summaryModel
      .findOne({ organizationId, storeId: storeConstraint ?? { $exists: false }, date: dateStr })
      .exec();
    return doc ? { ...doc.result, generatedAt: doc.updatedAt } : null;
  }

  private async getCachedPersonalSummary(organizationId: string, userId: string, dateStr: string) {
    const doc = await this.personalSummaryModel.findOne({ organizationId, userId, date: dateStr }).exec();
    return doc ? { ...doc.result, generatedAt: doc.updatedAt } : null;
  }

  // Shared by getOverview/generateSummary and getPersonalOverview/
  // generatePersonalSummary so all four never compute "today's activity"
  // differently. personalConstraint (a consultant's own userId) and
  // storeConstraint are mutually exclusive — the org/store call sites never
  // pass personalConstraint, and vice versa. timezoneStoreId is used ONLY
  // for timezone resolution (decoupled from data scoping) so a consultant's
  // "today" boundary still respects their own store's timezone.
  private async gatherActivity(organizationId: string, storeConstraint?: string, personalConstraint?: string, timezoneStoreId?: string) {
    const tz = await this.resolveTimezone(organizationId, timezoneStoreId ?? storeConstraint);
    const { dateStr, start, end } = todayBoundary(tz);

    const dealMatch: Record<string, unknown> = {
      organizationId,
      ...(personalConstraint ? { ownerId: personalConstraint } : storeConstraint ? { storeId: storeConstraint } : {}),
    };
    const deals = await this.dealModel.find(dealMatch).exec();
    const dealIds = new Set(deals.map((d) => d._id.toString()));

    // Quote has no storeId AND no ownerId of its own — scope via the
    // matched deal set. Store scope (existing, unchanged): a quote whose
    // dealId isn't in this org's deal set at all (external-sync timing gap)
    // is still included rather than dropped. Personal scope (new, stricter):
    // a quote with no dealId can never be attributed to one specific
    // consultant — the lenient "include if unlinked" behavior would leak
    // every org-wide orphan quote into every consultant's personal view, so
    // it must be excluded here, not just left unscoped.
    const quotes = await this.quoteModel.find({ organizationId }).exec();
    const scopedQuotes = personalConstraint
      ? quotes.filter((q) => q.dealId && dealIds.has(q.dealId))
      : storeConstraint
        ? quotes.filter((q) => !q.dealId || dealIds.has(q.dealId))
        : quotes;

    const accountIds = [...new Set(deals.map((d) => d.accountId).filter((id): id is string => !!id))];
    const accounts = accountIds.length ? await this.accountModel.find({ organizationId, _id: { $in: accountIds } }).exec() : [];
    const accountNameById = new Map(accounts.map((a): [string, string] => [a._id.toString(), a.name]));
    const accountDomainById = new Map(
      accounts.filter((a) => a.domain).map((a): [string, string] => [a._id.toString(), a.domain!]),
    );

    const groups = buildBusinessGroups(deals, scopedQuotes, accountNameById, accountDomainById);
    const accountsById = new Map(accounts.map((a): [string, AccountDocument] => [a._id.toString(), a]));

    const isToday = (d?: Date) => !!d && d >= start && d <= end;
    const daysSince = (d?: Date) => (d ? Math.max(0, Math.floor((start.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000)) : 0);
    // Deal/Quote sync writes via raw pymongo (crm_mongo_sync.py), which never
    // touches Mongoose's own `updatedAt` — lastActivityAt is that sync's own
    // change-aware signal (only bumped when a real field value changed, not
    // on every unchanged re-poll). Natively-created/edited records never get
    // lastActivityAt, so they correctly fall back to real Mongoose updatedAt.
    // Quote goes one step further: it has no equivalent of Deal's incidental
    // Mongoose-driven updatedAt (confirmed live — nothing has ever written a
    // Quote via Mongoose), so updatedAt is genuinely absent there; createdAt
    // (guaranteed present via crm_mongo_sync.py's $setOnInsert) is the final,
    // always-safe fallback for both.
    const activityDate = (d: { lastActivityAt?: Date; updatedAt?: Date; createdAt?: Date }) =>
      d.lastActivityAt ?? d.updatedAt ?? d.createdAt;

    const unactionedDeals = deals
      .filter((d) => d.dealStatus === 'open' && !isToday(activityDate(d)))
      .map((d) => ({
        type: 'deal' as const,
        id: d._id.toString(),
        name: d.name,
        businessName: groupKeyFor(d, accountNameById).businessName,
        daysSinceLastUpdate: daysSince(activityDate(d)),
      }));
    const unactionedQuotes = scopedQuotes
      .filter((q) => q.quoteStatus !== 'won' && q.quoteStatus !== 'lost' && !isToday(activityDate(q)))
      .map((q) => ({
        type: 'quote' as const,
        id: q._id.toString(),
        name: q.quoteName ?? q.quoteNumber ?? 'Untitled quote',
        businessName: q.clientDetails?.companyName ?? groups.get(quoteGroupKey(q, deals))?.businessName ?? q.quoteName ?? 'Unknown',
        daysSinceLastUpdate: daysSince(activityDate(q)),
      }));

    const lostWithReason = deals
      .filter((d) => d.dealStatus === 'lost')
      .map((d) => ({
        dealId: d._id.toString(),
        name: d.name,
        businessName: groupKeyFor(d, accountNameById).businessName,
        monetaryValue: d.monetaryValue,
        lostReason: d.lostReason ?? null,
        lostReasonSource: d.lostReasonSource ?? null,
      }));

    const actionedDealsToday = deals.filter((d) => isToday(activityDate(d)));
    const actionedQuotesToday = scopedQuotes.filter((q) => isToday(activityDate(q)));

    // Existing/New/Follow-up counts — independent, not mutually exclusive
    // (see plan §5b): computed over the set of businesses actioned today.
    const actionedGroupKeys = new Set([
      ...actionedDealsToday.map((d) => groupKeyFor(d, accountNameById).key),
      ...actionedQuotesToday.map((q) => quoteGroupKey(q, deals)),
    ]);
    let existingCount = 0;
    let newCount = 0;
    let followUpCount = 0;
    for (const key of actionedGroupKeys) {
      const group = groups.get(key);
      if (!group) continue;
      const earliestCreated = Math.min(
        ...group.deals.map((d) => new Date(d.createdAt ?? d.updatedAt).getTime()),
        ...group.quotes.map((q) => new Date(q.createdAt ?? q.updatedAt).getTime()),
      );
      if (Number.isFinite(earliestCreated)) {
        if (earliestCreated >= start.getTime()) newCount++;
        else existingCount++;
      }
      const hasFollowUp = group.deals.some(
        (d) => d.dealStatus === 'open' && d.expectedClosingDate && d.expectedClosingDate <= this.daysFromNow(FOLLOW_UP_WINDOW_DAYS),
      );
      if (hasFollowUp) followUpCount++;
    }

    // Contact.email exact-match set — realistically sparse for external-CRM
    // orgs (no Contact sync exists), but included since native/manually
    // entered contacts still count as real, high-confidence matches.
    const contacts = await this.contactModel.find({ organizationId, email: { $exists: true, $nin: [null, ''] } }).exec();
    const exactEmails = new Set<string>();
    for (const c of contacts) if (c.email) exactEmails.add(c.email.toLowerCase());
    // Quote.clientDetails.email is a real customer contact email sourced
    // directly from the external CRM's quote data — confirmed live to be
    // populated and reliable, so treated as an equally "exact" source.
    for (const q of scopedQuotes) if (q.clientDetails?.email) exactEmails.add(q.clientDetails.email.toLowerCase());

    const domains = new Set<string>();
    for (const d of accountDomainById.values()) if (d) domains.add(d.toLowerCase());

    const businessNamesForFuzzy = [...groups.values()].map((g) => ({ key: g.key, name: g.businessName }));

    const todaysEmails = await this.fetchTodaysEmailsForScope(organizationId, storeConstraint, personalConstraint);
    const correlatedEmails = this.correlateEmails(todaysEmails, exactEmails, domains, businessNamesForFuzzy);

    const businessTable = [...groups.values()].map((g) => {
      const openDeals = g.deals.filter((d) => d.dealStatus === 'open');
      const isFollowUp = openDeals.some((d) => d.expectedClosingDate && d.expectedClosingDate <= this.daysFromNow(FOLLOW_UP_WINDOW_DAYS));
      const earliestCreated = Math.min(
        ...g.deals.map((d) => new Date(d.createdAt ?? d.updatedAt).getTime()),
        ...g.quotes.map((q) => new Date(q.createdAt ?? q.updatedAt).getTime()),
      );
      const actionedToday = g.deals.some((d) => isToday(activityDate(d))) || g.quotes.some((q) => isToday(activityDate(q)));
      return {
        key: g.key,
        businessName: g.businessName,
        businessNameSource: g.businessNameSource,
        quoteNumbers: g.quotes.map((q) => q.quoteNumber).filter((n): n is string => !!n),
        dealCount: g.deals.length,
        quoteCount: g.quotes.length,
        openDealCount: openDeals.length,
        wonCount: g.deals.filter((d) => d.dealStatus === 'won').length,
        lostCount: g.deals.filter((d) => d.dealStatus === 'lost').length,
        isNew: Number.isFinite(earliestCreated) && earliestCreated >= start.getTime(),
        isFollowUp,
        actionedToday,
      };
    });

    return {
      dateStr,
      timezone: tz,
      businessTable,
      actionedTodayCounts: { existing: existingCount, new: newCount, followUp: followUpCount },
      totalActionedToday: actionedGroupKeys.size,
      unactionedItems: [...unactionedDeals, ...unactionedQuotes],
      lostWithReason,
      todaysDigest: {
        actionedDeals: actionedDealsToday.map((d) => ({ dealId: d._id.toString(), name: d.name })),
        actionedQuotes: actionedQuotesToday.map((q) => ({ quoteId: q._id.toString(), name: q.quoteName, quoteNumber: q.quoteNumber })),
      },
      correlatedEmails,
      emailCorrelationCoverage: {
        exactMatchableContacts: exactEmails.size,
        note:
          exactEmails.size === 0
            ? 'No CRM contact/quote emails available yet to correlate against — connect/sync more customer data for higher-confidence matches.'
            : `${exactEmails.size} known customer email(s) available for exact matching.`,
      },
      // Internal only — deliberately stripped in toOverviewShape/toLlmPayload
      // before anything reaches the public API. Exists so getRelationshipView
      // (Phase 14a) can look up one business's full Deal/Quote/Account
      // documents without recomputing gatherActivity's grouping a second time.
      groupsByKey: groups,
      accountsById,
    };
  }

  private toOverviewShape(activity: Awaited<ReturnType<CustomerActivityService['gatherActivity']>>) {
    const { dateStr, groupsByKey, accountsById, ...rest } = activity;
    return { date: dateStr, ...rest };
  }

  private toLlmPayload(activity: Awaited<ReturnType<CustomerActivityService['gatherActivity']>>) {
    return {
      date: activity.dateStr,
      businessTable: activity.businessTable,
      actionedTodayCounts: activity.actionedTodayCounts,
      unactionedItems: activity.unactionedItems.slice(0, 100),
      lostWithReason: activity.lostWithReason.slice(0, 50),
      todaysDigest: activity.todaysDigest,
      correlatedEmails: activity.correlatedEmails.slice(0, 100),
    };
  }

  // Owner/admin/manager path — same canOverride/storeConstraint pattern the
  // sibling overview endpoint already uses. Reuses gatherActivity's internal
  // groupsByKey/accountsById (never exposed via toOverviewShape/toLlmPayload)
  // rather than recomputing the business-grouping pass a second time.
  async getRelationshipView(caller: JwtPayload, businessKey: string, storeConstraint?: string) {
    const activity = await this.gatherActivity(caller.organizationId, storeConstraint);
    return this.buildRelationshipView(activity, businessKey);
  }

  // Consultant-only, self-scoped — mirrors getPersonalOverview's precedent
  // (no owner/admin override to view a specific consultant's feed).
  async getPersonalRelationshipView(caller: JwtPayload, businessKey: string) {
    const activity = await this.gatherActivity(caller.organizationId, undefined, caller.sub, caller.storeId);
    return this.buildRelationshipView(activity, businessKey);
  }

  private buildRelationshipView(activity: Awaited<ReturnType<CustomerActivityService['gatherActivity']>>, businessKey: string) {
    const group = activity.groupsByKey.get(businessKey);
    if (!group) throw new NotFoundException('Business not found in this scope');

    const account = group.businessNameSource === 'account' ? activity.accountsById.get(group.key) : undefined;
    const correlatedEmails = activity.correlatedEmails.filter((e) => e.matchedBusinessKey === group.key);

    return {
      key: group.key,
      businessName: group.businessName,
      businessNameSource: group.businessNameSource,
      account: account
        ? { name: account.name, domain: account.domain, city: account.city, industry: account.industry, revenue: account.revenue }
        : null,
      quotes: group.quotes.map((q) => ({
        id: q._id.toString(),
        quoteNumber: q.quoteNumber ?? null,
        quoteName: q.quoteName ?? null,
        quoteStatus: q.quoteStatus,
        quoteAmount: q.quoteAmount,
        currency: q.currency,
        clientDetails: q.clientDetails ?? null,
        dealId: q.dealId ?? null,
        // Additive (Phase 14c) — lets the Customer Timeline merge quotes into
        // a chronological feed without a second query.
        createdAt: q.createdAt ?? null,
      })),
      deals: group.deals.map((d) => ({
        id: d._id.toString(),
        name: d.name,
        dealStatus: d.dealStatus,
        monetaryValue: d.monetaryValue,
        expectedClosingDate: d.expectedClosingDate ?? null,
        stageId: d.stageId ?? null,
        // Additive (Phase 14c) — same reasoning as Quote.createdAt above.
        createdAt: d.createdAt ?? null,
      })),
      // Deliberately today-only — no multi-day Outlook fetch endpoint exists
      // yet (real-time email intelligence is a later, separate sub-phase).
      correlatedEmails,
    };
  }

  // Phase 14b — a deliberately separate, unscoped (whole-org, not store/
  // personal-constrained) counterpart to gatherActivity's own internal
  // exact/domain/group computation. Kept independent rather than having
  // gatherActivity delegate here: gatherActivity's deals/quotes are always
  // store/personal-scoped for its own callers, while Email Intelligence's
  // scheduled poller correlates one org's mailboxes against the WHOLE org's
  // CRM data regardless of which store/consultant a match belongs to — a
  // shared implementation would either wrongly scope one caller or the
  // other. Some duplication with gatherActivity's setup is accepted as the
  // safer trade-off against risking a regression in the already-verified
  // Customer Activity feature.
  async gatherCorrelationContext(organizationId: string): Promise<EmailCorrelationContext> {
    const deals = await this.dealModel.find({ organizationId }).exec();
    const quotes = await this.quoteModel.find({ organizationId }).exec();

    const accountIds = [...new Set(deals.map((d) => d.accountId).filter((id): id is string => !!id))];
    const accounts = accountIds.length ? await this.accountModel.find({ organizationId, _id: { $in: accountIds } }).exec() : [];
    const accountNameById = new Map(accounts.map((a): [string, string] => [a._id.toString(), a.name]));
    const accountDomainById = new Map(
      accounts.filter((a) => a.domain).map((a): [string, string] => [a._id.toString(), a.domain!]),
    );

    const groups = buildBusinessGroups(deals, quotes, accountNameById, accountDomainById);

    const contacts = await this.contactModel.find({ organizationId, email: { $exists: true, $nin: [null, ''] } }).exec();
    const exactEmails = new Set<string>();
    for (const c of contacts) if (c.email) exactEmails.add(c.email.toLowerCase());

    const emailToGroupKey = new Map<string, string>();
    for (const q of quotes) {
      if (!q.clientDetails?.email) continue;
      const email = q.clientDetails.email.toLowerCase();
      exactEmails.add(email);
      emailToGroupKey.set(email, quoteGroupKey(q, deals));
    }

    const domains = new Set<string>();
    const domainToGroupKey = new Map<string, string>();
    for (const [accountId, domain] of accountDomainById) {
      if (!domain) continue;
      const lower = domain.toLowerCase();
      domains.add(lower);
      domainToGroupKey.set(lower, accountId);
    }

    return {
      exactEmails,
      domains,
      businessNamesForFuzzy: [...groups.values()].map((g) => ({ key: g.key, name: g.businessName })),
      emailToGroupKey,
      domainToGroupKey,
      groups,
    };
  }

  // Phase 14e — stamps lastActivityAt on every Deal in this business group,
  // so a business replied-to via Email Intelligence correctly shows up in
  // "actioned today" everywhere that already reads
  // lastActivityAt ?? updatedAt ?? createdAt (Phase 11's convention) — for
  // free, no other code needs to change. Also returns one deal id from the
  // group (if any) so callers needing to link a new record to "the" deal for
  // this business (e.g. a draft Quote) don't need a second correlation-
  // context gather. Best-effort — callers decide whether a failure here
  // should block anything (it never should).
  async touchBusinessActivity(organizationId: string, groupKey: string): Promise<{ touchedCount: number; dealId?: string }> {
    const context = await this.gatherCorrelationContext(organizationId);
    const group = context.groups.get(groupKey);
    if (!group || group.deals.length === 0) return { touchedCount: 0 };

    const dealIds = group.deals.map((d) => d._id);
    const result = await this.dealModel
      .updateMany({ _id: { $in: dealIds } }, { $set: { lastActivityAt: new Date() } })
      .exec();
    return { touchedCount: result.modifiedCount, dealId: group.deals[0]._id.toString() };
  }

  // Phase 19 — Unified Analytics Dashboard's "customer new/existing/lost"
  // widget. A month-scoped generalization of gatherActivity's own New/
  // Existing counting (same earliest-created-in-period rule), plus a new
  // "Lost" bucket with no prior precedent anywhere in this codebase: a
  // business counts as Lost in month M when it's not New, has no currently-
  // open deal, and its single most-recent touch across the whole group
  // (lastActivityAt ?? updatedAt ?? createdAt, the same fallback chain
  // gatherActivity already uses) is a Deal with dealStatus 'lost' landing in
  // month M — i.e. the last thing that happened to this relationship was a
  // loss, and it happened this month, with nothing having reopened since.
  // Reuses buildBusinessGroups/groupKeyFor/quoteGroupKey completely
  // unmodified — that grouping logic has no day/month dependency baked in,
  // only gatherActivity's own "today" boundary does. Groups with zero
  // activity in the month appear in none of the three buckets, same
  // "only actioned items count" framing gatherActivity already uses for
  // "today" — totalConsidered makes this explicit rather than implying "all
  // customers, all time."
  // Generalized (Phase 19 follow-up) from a locked calendar-month period to
  // an arbitrary [start, end) Date range — the Customers & Email tab gained
  // a shared day-based filter so "New Customers" and "Emails Sent/Missed"
  // always describe the exact same window instead of one being month-
  // scoped and the other day-scoped, which read as inconsistent/"wrong"
  // even though each number was independently correct for its own filter.
  async getCustomerBreakdownForRange(
    organizationId: string,
    start: Date,
    end: Date,
    storeConstraint?: string,
    personalConstraint?: string,
  ): Promise<{
    newCount: number;
    existingCount: number;
    lostCount: number;
    totalConsidered: number;
    // Additive — backs the dashboard's Customer Mix drill-down popup (click
    // a segment to see which businesses landed in it). Same {key, businessName}
    // shape as BusinessTableRow so the frontend can reuse it for the
    // relationship-view lookup (GET /crm/customer-activity/relationships/:businessKey).
    newItems: { key: string; businessName: string }[];
    existingItems: { key: string; businessName: string }[];
    lostItems: { key: string; businessName: string }[];
  }> {
    const dealMatch: Record<string, unknown> = {
      organizationId,
      ...(personalConstraint ? { ownerId: personalConstraint } : storeConstraint ? { storeId: storeConstraint } : {}),
    };
    const deals = await this.dealModel.find(dealMatch).exec();
    const dealIds = new Set(deals.map((d) => d._id.toString()));

    const quotes = await this.quoteModel.find({ organizationId }).exec();
    const scopedQuotes = personalConstraint
      ? quotes.filter((q) => q.dealId && dealIds.has(q.dealId))
      : storeConstraint
        ? quotes.filter((q) => !q.dealId || dealIds.has(q.dealId))
        : quotes;

    const accountIds = [...new Set(deals.map((d) => d.accountId).filter((id): id is string => !!id))];
    const accounts = accountIds.length ? await this.accountModel.find({ organizationId, _id: { $in: accountIds } }).exec() : [];
    const accountNameById = new Map(accounts.map((a): [string, string] => [a._id.toString(), a.name]));
    const accountDomainById = new Map(
      accounts.filter((a) => a.domain).map((a): [string, string] => [a._id.toString(), a.domain!]),
    );

    const groups = buildBusinessGroups(deals, scopedQuotes, accountNameById, accountDomainById);

    const activityDate = (d: { lastActivityAt?: Date; updatedAt?: Date; createdAt?: Date }) =>
      d.lastActivityAt ?? d.updatedAt ?? d.createdAt;
    const inMonth = (d?: Date) => !!d && d >= start && d < end;

    let newCount = 0;
    let existingCount = 0;
    let lostCount = 0;
    const newItems: { key: string; businessName: string }[] = [];
    const existingItems: { key: string; businessName: string }[] = [];
    const lostItems: { key: string; businessName: string }[] = [];

    for (const group of groups.values()) {
      const allCreated = [
        ...group.deals.map((d) => new Date(d.createdAt ?? d.updatedAt ?? 0).getTime()),
        ...group.quotes.map((q) => new Date(q.createdAt ?? q.updatedAt ?? 0).getTime()),
      ].filter((t) => Number.isFinite(t) && t > 0);
      if (allCreated.length === 0) continue;
      const earliestCreated = Math.min(...allCreated);

      if (earliestCreated >= start.getTime() && earliestCreated < end.getTime()) {
        newCount++;
        newItems.push({ key: group.key, businessName: group.businessName });
        continue;
      }

      const hadActivityInMonth =
        group.deals.some((d) => inMonth(activityDate(d))) || group.quotes.some((q) => inMonth(activityDate(q)));
      if (!hadActivityInMonth) continue;

      const hasOpenDeal = group.deals.some((d) => d.dealStatus === 'open');
      if (hasOpenDeal) {
        existingCount++;
        existingItems.push({ key: group.key, businessName: group.businessName });
        continue;
      }

      const touches = [
        ...group.deals.map((d) => ({
          date: new Date(activityDate(d) ?? d.createdAt ?? 0).getTime(),
          isLostDeal: d.dealStatus === 'lost',
        })),
        ...group.quotes.map((q) => ({ date: new Date(activityDate(q) ?? q.createdAt ?? 0).getTime(), isLostDeal: false })),
      ]
        .filter((t) => Number.isFinite(t.date) && t.date > 0)
        .sort((a, b) => b.date - a.date);
      const mostRecent = touches[0];

      if (mostRecent?.isLostDeal && mostRecent.date >= start.getTime() && mostRecent.date < end.getTime()) {
        lostCount++;
        lostItems.push({ key: group.key, businessName: group.businessName });
      } else {
        existingCount++;
        existingItems.push({ key: group.key, businessName: group.businessName });
      }
    }

    return {
      newCount,
      existingCount,
      lostCount,
      totalConsidered: newCount + existingCount + lostCount,
      newItems,
      existingItems,
      lostItems,
    };
  }

  // Back-compat convenience for callers that still think in calendar months
  // (AnalyticsDashboardService's composite overview) — converts to a range
  // and delegates, so the two never compute this differently.
  async getMonthlyCustomerBreakdown(organizationId: string, period: string, storeConstraint?: string, personalConstraint?: string) {
    const { start, end } = periodToDateRange(period);
    return this.getCustomerBreakdownForRange(organizationId, start, end, storeConstraint, personalConstraint);
  }

  private async resolveTimezone(organizationId: string, storeConstraint?: string): Promise<string> {
    try {
      if (storeConstraint) {
        const stores = await this.organizationsService.listStores(organizationId);
        const store = stores.find((s) => s._id.toString() === storeConstraint);
        if (store?.timezone) return store.timezone;
      } else {
        // Org-wide (owner/admin): no single correct timezone across
        // multiple stores — default to the org's first store, same
        // documented simplification as business-dashboard.service.ts's
        // todayStamp() being server-UTC-only with no per-store awareness.
        const stores = await this.organizationsService.listStores(organizationId);
        if (stores[0]?.timezone) return stores[0].timezone;
      }
    } catch {
      // fall through to UTC
    }
    return 'UTC';
  }

  private daysFromNow(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Outlook is per-user OAuth, not per-org — loop over every user in scope
  // and silently skip anyone not connected, same pattern
  // business-dashboard.service.ts's getManagerOverview already uses for
  // teamCalendarEvents. personalConstraint skips the org-wide user lookup
  // entirely and fetches just that one consultant's own mailbox.
  private async fetchTodaysEmailsForScope(
    organizationId: string,
    storeConstraint?: string,
    personalConstraint?: string,
  ): Promise<TodaysEmail[]> {
    const userIds = personalConstraint
      ? [personalConstraint]
      : (await this.usersService.findAll(organizationId))
          .filter((u) => !storeConstraint || u.storeId === storeConstraint)
          .map((u) => u._id.toString());

    const results = await Promise.all(
      userIds.map(async (id) => {
        try {
          const token = this.jwt.sign({ sub: id }, { expiresIn: '5m' });
          const { data } = await firstValueFrom(
            this.http.get<{ connected: boolean; emails: TodaysEmail[] }>(`${this.pythonAgentUrl}/outlook/todays-emails`, {
              headers: { Authorization: `Bearer ${token}` },
            }),
          );
          return data.connected ? data.emails : [];
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  private correlateEmails(
    emails: TodaysEmail[],
    exactEmails: Set<string>,
    domains: Set<string>,
    businesses: { key: string; name: string }[],
  ): CorrelatedEmail[] {
    const out: CorrelatedEmail[] = [];
    for (const email of emails) {
      const parties = [email.from, ...email.to].filter(Boolean).map((a) => a.toLowerCase());

      const exactHit = parties.find((a) => exactEmails.has(a));
      if (exactHit) {
        out.push({ ...email, matchConfidence: 'exact', matchedBusinessKey: exactHit, matchedBusinessName: exactHit });
        continue;
      }

      const domainHit = parties.map((a) => a.split('@')[1]).find((d) => d && domains.has(d));
      if (domainHit) {
        out.push({ ...email, matchConfidence: 'domain', matchedBusinessKey: domainHit, matchedBusinessName: domainHit });
        continue;
      }

      const haystack = normalizeKey(`${email.subject} ${email.from}`);
      const fuzzyHit = businesses.find((b) => b.name.length > 3 && haystack.includes(normalizeKey(b.name)));
      if (fuzzyHit) {
        out.push({ ...email, matchConfidence: 'fuzzy', matchedBusinessKey: fuzzyHit.key, matchedBusinessName: fuzzyHit.name });
      }
    }
    return out;
  }
}
