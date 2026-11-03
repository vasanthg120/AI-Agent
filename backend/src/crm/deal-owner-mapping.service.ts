import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Deal, DealDocument } from './schemas/deal.schema';
import { DealOwnerMapping, DealOwnerMappingDocument } from './schemas/deal-owner-mapping.schema';
import { Account, AccountDocument } from './schemas/account.schema';
import { Quote, QuoteDocument } from './schemas/quote.schema';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';
import { DealsService } from './deals.service';
import { ListDealsQueryDto } from './dto/list-deals-query.dto';
import { buildBusinessGroups, groupKeyFor, BusinessNameSource } from './customer-grouping.util';

export interface ExternalOwnerRow {
  provider: string;
  externalOwnerRef: string;
  externalOwnerLabel?: string;
  dealCount: number;
  mapping: {
    id: string;
    // Set only when linkedUserIds has exactly one entry — the auto-
    // assignable owner. Undefined for an ambiguous (2+ linked users) mapping.
    ownerId?: string;
    ownerName?: string;
    // The full set of linked users — always [ownerId] when ownerId is set.
    linkedUserIds: string[];
    linkedUsers: { id: string; name?: string }[];
  } | null;
  // Best-effort match between this CRM's raw owner label and a current
  // employee's name/email — purely a hint the admin still has to click to
  // confirm (see upsertMapping below); never applied automatically, since a
  // raw external id genuinely has no reliable automatic identity match (see
  // this file's own header comment). Set only when exactly one employee
  // matches — an ambiguous label suggests nothing rather than guessing.
  suggestedOwnerId?: string;
  suggestedOwnerName?: string;
}

// The row shape Settings → Deal Assignment actually renders — a Deal plus
// everything needed to answer "who owns this and do we trust that" without
// the frontend re-deriving any of it. ownershipStatus is the direct fix for
// the reported "shows Unassigned even though the CRM has a real owner" bug:
// 'assigned' (ownerId set — manually or via a resolved mapping), versus
// 'pending_mapping' (the CRM's own externalOwnerRef is present but not yet
// mapped to a user — genuinely NOT the same thing as no owner at all),
// versus 'unassigned' (neither — the only case that should ever render the
// word "Unassigned").
export interface AssignmentDealRow {
  _id: string;
  name: string;
  dealStatus: 'open' | 'won' | 'lost';
  monetaryValue: number;
  expectedClosingDate?: string;
  ownerId?: string;
  // Undefined (never a fabricated "Unknown user" string) when ownerId points
  // at an id with no current employee — same "never invent a name" rule
  // business-dashboard.service.ts's leaderboard already applies.
  ownerName?: string;
  externalOwnerRef?: string;
  externalOwnerLabel?: string;
  externalOwnerProvider?: string;
  ownershipStatus: 'assigned' | 'pending_mapping' | 'unassigned';
  // Best-effort customer/account label — an Account name when the deal is
  // actually linked to one, else whatever customer-grouping.util.ts's
  // established resolution (already used by Customer Activity/Relationships)
  // finds: a linked quote's real clientDetails.companyName, or worst case a
  // heuristic split of the deal's own name. customerNameSource lets the UI
  // show the same "derived, not authoritative" hint CustomerActivityTable
  // already shows, rather than presenting a guess as fact.
  customerName?: string;
  customerNameSource?: BusinessNameSource;
}

// Case-insensitive match of a CRM's raw owner label against a current
// employee's full name or email local-part — the "dynamically identify the
// correct Deal Owner" half of the mapping UI, layered on top of (never
// replacing) the manual mapping flow below. Deliberately conservative: any
// label matching more than one employee suggests nothing rather than
// guessing wrong, since a wrong auto-suggestion an admin clicks through
// blind is worse than no suggestion at all.
function findSuggestedOwner(label: string | undefined, users: UserDocument[]): { id: string; name: string } | undefined {
  const normalized = label?.trim().toLowerCase();
  if (!normalized) return undefined;
  const matches = users.filter((u) => {
    const name = u.name?.trim().toLowerCase();
    const emailLocal = u.email?.split('@')[0]?.toLowerCase();
    return name === normalized || emailLocal === normalized;
  });
  return matches.length === 1 ? { id: matches[0]._id.toString(), name: matches[0].name } : undefined;
}

// The configurable half of "map the CRM's real deal-owner field to a real
// user" — see deal.schema.ts's own comment on externalOwnerRef for the full
// design. Provider-agnostic: this service never references "prospectconnect"
// by name, only whatever provider string each synced Deal itself carries.
@Injectable()
export class DealOwnerMappingService {
  constructor(
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(DealOwnerMapping.name) private mappingModel: Model<DealOwnerMappingDocument>,
    @InjectModel(Account.name) private accountModel: Model<AccountDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    private usersService: UsersService,
    private dealsService: DealsService,
  ) {}

  // Settings → Deal Assignment's own list — deliberately separate from
  // DealsController's plain GET /crm/deals/query (reused internally below,
  // never duplicated): that endpoint's only other consumer
  // (AnalyticsDashboardPage.tsx) doesn't need a customer join or an
  // owner-name/ownership-status computed per row, and adding that cost to a
  // generic hot path for a consumer that never asked for it would be scope
  // creep. needsMappingOnly is a real Mongo condition on Deal.ownerId
  // (applied via DealsService.listFiltered's extraMatch), not an in-memory
  // filter — pagination/totals stay correct.
  async listDealsForAssignment(
    organizationId: string,
    query: ListDealsQueryDto,
    needsMappingOnly: boolean,
    storeConstraint?: string,
  ): Promise<{ items: AssignmentDealRow[]; total: number; page: number; pageSize: number }> {
    const extraMatch = needsMappingOnly ? { ownerId: { $exists: false } } : undefined;
    const { items: deals, total, page, pageSize } = await this.dealsService.listFiltered(organizationId, query, storeConstraint, extraMatch);

    const dealIds = deals.map((d) => d._id.toString());
    const accountIds = [...new Set(deals.map((d) => d.accountId).filter((id): id is string => !!id))];

    const [users, accounts, quotes] = await Promise.all([
      this.usersService.findAll(organizationId),
      accountIds.length ? this.accountModel.find({ organizationId, _id: { $in: accountIds } }).exec() : Promise.resolve([]),
      // Deals synced from an external CRM never carry accountId/contactId
      // (crm_mongo_sync.py's _to_native_update never sets them — confirmed,
      // see this module's own deal.schema.ts comments) — a linked Quote's
      // real clientDetails is the only genuine customer signal available for
      // those, same reasoning quotes.service.ts and the royalty invoice
      // draft flow already rely on.
      dealIds.length ? this.quoteModel.find({ organizationId, dealId: { $in: dealIds } }).exec() : Promise.resolve([]),
    ]);

    const userNameById = new Map(users.map((u): [string, string] => [u._id.toString(), u.name]));
    const accountNameById = new Map(accounts.map((a): [string, string] => [a._id.toString(), a.name]));
    const accountDomainById = new Map(accounts.filter((a) => a.domain).map((a): [string, string] => [a._id.toString(), a.domain!]));
    // Reuses customer-activity.service.ts's own established business-name
    // resolution (Account name, else a linked quote's real clientDetails
    // company name, else a labeled heuristic guess from the deal name) —
    // not reinvented here.
    const groups = buildBusinessGroups(deals, quotes, accountNameById, accountDomainById);

    const items: AssignmentDealRow[] = deals.map((d) => {
      const ownerId = d.ownerId;
      const externalOwnerRef = d.externalOwnerRef;
      const ownershipStatus: AssignmentDealRow['ownershipStatus'] = ownerId ? 'assigned' : externalOwnerRef ? 'pending_mapping' : 'unassigned';
      const group = groups.get(groupKeyFor(d, accountNameById).key);

      return {
        _id: d._id.toString(),
        name: d.name,
        dealStatus: d.dealStatus,
        monetaryValue: d.monetaryValue,
        expectedClosingDate: d.expectedClosingDate,
        ownerId,
        ownerName: ownerId ? userNameById.get(ownerId) : undefined,
        externalOwnerRef,
        externalOwnerLabel: d.externalOwnerLabel,
        externalOwnerProvider: d.externalOwnerProvider,
        ownershipStatus,
        customerName: group?.businessName,
        customerNameSource: group?.businessNameSource,
      };
    });

    return { items, total, page, pageSize };
  }

  // Every distinct raw external-owner value seen across this org's synced
  // deals, each with a deal count and its current mapping (if any) — the
  // full picture an admin needs to finish mapping every real salesperson at
  // once, not just react to one deal at a time.
  async listExternalOwners(organizationId: string): Promise<ExternalOwnerRow[]> {
    const [grouped, mappings, users] = await Promise.all([
      this.dealModel
        .aggregate<{ _id: { provider: string; ref: string }; label?: string; count: number }>([
          { $match: { organizationId, externalOwnerRef: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: { provider: '$externalOwnerProvider', ref: '$externalOwnerRef' },
              label: { $last: '$externalOwnerLabel' },
              count: { $sum: 1 },
            },
          },
        ])
        .exec(),
      this.mappingModel.find({ organizationId }).exec(),
      this.usersService.findAll(organizationId),
    ]);

    const userNameById = new Map(users.map((u) => [u._id.toString(), u.name]));
    const mappingByKey = new Map(mappings.map((m) => [`${m.provider}::${m.externalOwnerRef}`, m]));

    return grouped
      .map((g) => {
        const provider = g._id.provider ?? 'unknown';
        const ref = g._id.ref;
        const mapping = mappingByKey.get(`${provider}::${ref}`);
        const suggested = mapping ? undefined : findSuggestedOwner(g.label, users);
        // Backward compatibility: every mapping written before linkedUserIds
        // existed has it absent/empty but ownerId set — treat that exactly
        // as a one-element list, never as "no linked users" for a row that
        // plainly has an owner. No migration needed for this reason.
        const linkedUserIds = mapping ? (mapping.linkedUserIds?.length ? mapping.linkedUserIds : mapping.ownerId ? [mapping.ownerId] : []) : [];
        return {
          provider,
          externalOwnerRef: ref,
          externalOwnerLabel: g.label,
          dealCount: g.count,
          mapping: mapping
            ? {
                id: mapping._id.toString(),
                ownerId: mapping.ownerId,
                ownerName: mapping.ownerId ? userNameById.get(mapping.ownerId) : undefined,
                linkedUserIds,
                linkedUsers: linkedUserIds.map((id) => ({ id, name: userNameById.get(id) })),
              }
            : null,
          suggestedOwnerId: suggested?.id,
          suggestedOwnerName: suggested?.name,
        };
      })
      .sort((a, b) => b.dealCount - a.dealCount);
  }

  // Every user id must belong to this organization and be active — the
  // same bar deals.controller.ts's assertAssignable already applies to a
  // single manual assignment, applied here to the whole linked set so a
  // mapping can never reference a foreign or deactivated account.
  private async assertEligibleUsers(organizationId: string, userIds: string[]): Promise<void> {
    const users = await this.usersService.findAll(organizationId);
    const eligibleIds = new Set(users.filter((u) => u.active !== false).map((u) => u._id.toString()));
    const invalid = userIds.filter((id) => !eligibleIds.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException('One or more selected users are not eligible for assignment in this organization.');
    }
  }

  // Upserts the mapping with the given set of linked users. Linking is an
  // ASSOCIATION, never automatic ownership (see this module's own header
  // comment): only when the set resolves to exactly one user is there a
  // reliable deal-specific signal, so only then does this immediately bulk-
  // apply that owner to every existing deal/quote carrying this external
  // owner ref — "ensure deal ownership data is synchronized accurately",
  // not just recorded for next sync, exactly as the single-user case always
  // has (still overwrites a deal a human previously assigned manually: once
  // a real unambiguous mapping exists for this salesperson, it becomes the
  // authoritative source going forward, same as before this change). With
  // two or more linked users, nothing is bulk-applied — every existing
  // deal's ownerId, assigned or not, is left completely untouched, and an
  // admin resolves each one explicitly via the existing per-deal/bulk
  // assignment controls. Going back down to exactly one re-enables the
  // single-user behavior (including the bulk-apply) the same way creating
  // a brand-new single-user mapping does.
  async upsertMapping(
    organizationId: string,
    provider: string,
    externalOwnerRef: string,
    externalOwnerLabel: string | undefined,
    ownerIds: string[],
    mappedBy: string,
  ): Promise<ExternalOwnerRow> {
    const uniqueOwnerIds = [...new Set(ownerIds)];
    if (uniqueOwnerIds.length === 0) throw new BadRequestException('Link at least one user.');
    await this.assertEligibleUsers(organizationId, uniqueOwnerIds);

    const resolvedOwnerId = uniqueOwnerIds.length === 1 ? uniqueOwnerIds[0] : undefined;
    const mapping = await this.mappingModel
      .findOneAndUpdate(
        { organizationId, provider, externalOwnerRef },
        resolvedOwnerId
          ? { $set: { externalOwnerLabel, ownerId: resolvedOwnerId, linkedUserIds: uniqueOwnerIds, mappedBy } }
          : { $set: { externalOwnerLabel, linkedUserIds: uniqueOwnerIds, mappedBy }, $unset: { ownerId: '' } },
        { upsert: true, new: true },
      )
      .exec();

    let dealCount = 0;
    if (resolvedOwnerId) {
      const result = await this.dealModel.updateMany(
        { organizationId, externalOwnerProvider: provider, externalOwnerRef },
        { $set: { ownerId: resolvedOwnerId } },
      );
      dealCount = result.matchedCount;
      // The same person owns the quotations the CRM lists under that owner — a
      // link made for deals used to leave every synced quotation without a
      // HaiVE owner, so quote work showed as nobody's.
      await this.dealModel.db
        .collection('crm_quotes')
        .updateMany({ organizationId, sourceProvider: provider, quoteOwner: externalOwnerRef }, { $set: { ownerUserId: resolvedOwnerId } });
    }

    const users = await this.usersService.findAll(organizationId);
    const userNameById = new Map(users.map((u) => [u._id.toString(), u.name]));
    return {
      provider,
      externalOwnerRef,
      externalOwnerLabel: mapping.externalOwnerLabel,
      dealCount,
      mapping: {
        id: mapping._id.toString(),
        ownerId: resolvedOwnerId,
        ownerName: resolvedOwnerId ? userNameById.get(resolvedOwnerId) : undefined,
        linkedUserIds: uniqueOwnerIds,
        linkedUsers: uniqueOwnerIds.map((id) => ({ id, name: userNameById.get(id) })),
      },
    };
  }

  // Removes the mapping only — deliberately never retroactively unassigns
  // the deals it already applied to (those are now legitimately assigned;
  // silently mass-unassigning them on unmap would be a surprising,
  // destructive side effect). Use the existing per-deal control for any
  // one-off correction instead.
  async deleteMapping(organizationId: string, id: string): Promise<void> {
    const deleted = await this.mappingModel.findOneAndDelete({ _id: id, organizationId }).exec();
    if (!deleted) throw new NotFoundException('Mapping not found');
  }
}
