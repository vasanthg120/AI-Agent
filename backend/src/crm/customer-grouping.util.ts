import { DealDocument } from './schemas/deal.schema';
import { QuoteDocument } from './schemas/quote.schema';

// Extracted from customer-activity.service.ts (Phase 11/12) once the Phase
// 14a relationship view became a second real consumer of this exact
// business-grouping logic — a pure-function util, mirroring
// deal-filter.util.ts's convention (shared logic living in the module that
// owns the models, not exported cross-module). Behavior-preserving refactor:
// customer-activity.service.ts now imports these instead of defining them
// as private methods.

export type BusinessNameSource = 'account' | 'quote_client_details' | 'deal_name_heuristic';

export interface BusinessGroup {
  key: string;
  businessName: string;
  businessNameSource: BusinessNameSource;
  contactEmail?: string;
  accountDomain?: string;
  deals: DealDocument[];
  quotes: QuoteDocument[];
}

// Best-effort business-name extraction from a native/synced Deal.name string
// (e.g. "Noble hospital - Uniforms") when no real Account is linked — labeled
// businessNameSource: 'deal_name_heuristic' everywhere it's used, never
// presented as equally authoritative to a real Account/clientDetails name.
export function heuristicBusinessName(dealName: string): string {
  const match = /^(.+?)\s*[-–:]\s*.+$/.exec(dealName);
  return (match ? match[1] : dealName).trim();
}

export function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function groupKeyFor(deal: DealDocument, accountNameById: Map<string, string>): { key: string; businessName: string; source: BusinessNameSource } {
  if (deal.accountId && accountNameById.has(deal.accountId)) {
    // Keyed by the account's name, not its id: account ids belong to one CRM,
    // so the same company kept in two connected CRMs would otherwise count as
    // two customers in the unified view.
    const accountName = accountNameById.get(deal.accountId)!;
    return { key: normalizeKey(accountName), businessName: accountName, source: 'account' };
  }
  const name = heuristicBusinessName(deal.name);
  return { key: normalizeKey(name), businessName: name, source: 'deal_name_heuristic' };
}

export function quoteGroupKey(quote: QuoteDocument, deals: DealDocument[], accountNameById?: Map<string, string>): string {
  if (quote.dealId) {
    const deal = deals.find((d) => d._id.toString() === quote.dealId);
    if (deal) {
      // Same key groupKeyFor gives the deal, so a quote lands with its deal.
      const accountName = deal.accountId ? accountNameById?.get(deal.accountId) : undefined;
      if (accountName) return normalizeKey(accountName);
      return deal.accountId ?? normalizeKey(heuristicBusinessName(deal.name));
    }
  }
  if (quote.clientDetails?.email) return `email:${quote.clientDetails.email.toLowerCase()}`;
  if (quote.clientDetails?.companyName) return normalizeKey(quote.clientDetails.companyName);
  return normalizeKey(quote.quoteName ?? quote._id.toString());
}

export function buildBusinessGroups(
  deals: DealDocument[],
  quotes: QuoteDocument[],
  accountNameById: Map<string, string>,
  accountDomainById: Map<string, string | undefined>,
): Map<string, BusinessGroup> {
  const groups = new Map<string, BusinessGroup>();

  for (const deal of deals) {
    const { key, businessName, source } = groupKeyFor(deal, accountNameById);
    const group = groups.get(key) ?? {
      key,
      businessName,
      businessNameSource: source,
      accountDomain: deal.accountId ? accountDomainById.get(deal.accountId) : undefined,
      deals: [],
      quotes: [],
    };
    group.deals.push(deal);
    groups.set(key, group);
  }

  for (const quote of quotes) {
    const key = quoteGroupKey(quote, deals, accountNameById);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        businessName: quote.clientDetails?.companyName ?? quote.quoteName ?? 'Unknown business',
        businessNameSource: quote.clientDetails?.companyName ? 'quote_client_details' : 'deal_name_heuristic',
        contactEmail: quote.clientDetails?.email,
        deals: [],
        quotes: [],
      };
      groups.set(key, group);
    } else if (group.businessNameSource === 'deal_name_heuristic' && quote.clientDetails?.companyName) {
      // A real client-details name beats a guessed one — upgrade in place.
      group.businessName = quote.clientDetails.companyName;
      group.businessNameSource = 'quote_client_details';
      group.contactEmail = quote.clientDetails.email;
    }
    group.quotes.push(quote);
  }

  return groups;
}

// ---- Email correlation (Phase 14b) ----
//
// A per-email-at-a-time counterpart to customer-activity.service.ts's
// correlateEmails (which processes an array of "today's emails" against a
// precomputed context) — extracted here so Email Intelligence's scheduled
// poller can correlate one incoming email at a time without running the
// full org-wide "today's business table" computation gatherActivity does.
// CustomerActivityService.gatherCorrelationContext builds this context once
// per org per poll tick (not once per email).

export interface EmailCorrelationContext {
  exactEmails: Set<string>;
  domains: Set<string>;
  businessNamesForFuzzy: { key: string; name: string }[];
  // Real BusinessGroup.key lookups for exact/domain hits — customer-activity.service.ts's
  // existing correlateEmails leaves matchedBusinessKey as the raw matched
  // email/domain string for these two tiers (harmless there, since it never
  // needs to look the group back up) but this feature needs the actual
  // group to surface real previous quotes, hence these two extra maps.
  emailToGroupKey: Map<string, string>;
  domainToGroupKey: Map<string, string>;
  groups: Map<string, BusinessGroup>;
}

export interface EmailMatch {
  matchConfidence: 'exact' | 'domain' | 'fuzzy';
  matchedBusinessKey: string;
  matchedBusinessName: string;
  // Always a real, resolvable BusinessGroup.key when one exists — null for
  // an exact Contact-email match with no linked deal/account (Contact has
  // no accountId/deal-linkage field anywhere in this data model today, so
  // there is genuinely no group to attach it to; an empty business summary
  // in that case reflects real missing data, not a bug).
  resolvedGroupKey: string | null;
}

export function correlateSingleEmail(email: { from: string; to: string[]; subject: string }, ctx: EmailCorrelationContext): EmailMatch | null {
  const parties = [email.from, ...email.to].filter(Boolean).map((a) => a.toLowerCase());

  const exactHit = parties.find((a) => ctx.exactEmails.has(a));
  if (exactHit) {
    return {
      matchConfidence: 'exact',
      matchedBusinessKey: exactHit,
      matchedBusinessName: exactHit,
      resolvedGroupKey: ctx.emailToGroupKey.get(exactHit) ?? null,
    };
  }

  const domainHit = parties.map((a) => a.split('@')[1]).find((d) => d && ctx.domains.has(d));
  if (domainHit) {
    return {
      matchConfidence: 'domain',
      matchedBusinessKey: domainHit,
      matchedBusinessName: domainHit,
      resolvedGroupKey: ctx.domainToGroupKey.get(domainHit) ?? null,
    };
  }

  const haystack = normalizeKey(`${email.subject} ${email.from}`);
  const fuzzyHit = ctx.businessNamesForFuzzy.find((b) => b.name.length > 3 && haystack.includes(normalizeKey(b.name)));
  if (fuzzyHit) {
    return { matchConfidence: 'fuzzy', matchedBusinessKey: fuzzyHit.key, matchedBusinessName: fuzzyHit.name, resolvedGroupKey: fuzzyHit.key };
  }

  return null;
}
