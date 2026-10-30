import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Deal, DealDocument } from './schemas/deal.schema';
import { CreateDealDto } from './dto/create-deal.dto';
import { UpdateDealDto } from './dto/update-deal.dto';
import { DealFilterQueryDto } from './dto/deal-filter-query.dto';
import { ListDealsQueryDto } from './dto/list-deals-query.dto';
import { buildDealMatchStage } from './deal-filter.util';

@Injectable()
export class DealsService {
  constructor(@InjectModel(Deal.name) private dealModel: Model<DealDocument>) {}

  list(organizationId: string, storeId?: string) {
    return this.dealModel
      .find({ organizationId, ...(storeId ? { storeId } : {}) })
      .sort({ expectedClosingDate: -1 })
      .exec();
  }

  // storeId, when passed, scopes the match itself (not just the input) —
  // a manager can only ever touch a deal that's actually in their own store,
  // regardless of what the caller claims.
  async assignOwner(id: string, organizationId: string, ownerId: string | null, storeId?: string) {
    const filter = { _id: id, organizationId, ...(storeId ? { storeId } : {}) };
    // ownerAssignedManually marks this as a deliberate human assignment —
    // see deal.schema.ts's own comment on the field: a background CRM
    // re-sync checks it before ever applying a mapped owner, so it never
    // silently overwrites what's set here. Unassigning clears it too,
    // which deliberately opts the deal back into automatic resolution.
    const update = ownerId ? { $set: { ownerId, ownerAssignedManually: true } } : { $unset: { ownerId: '', ownerAssignedManually: '' } };
    const updated = await this.dealModel.findOneAndUpdate(filter, update, { new: true }).exec();
    if (!updated) throw new NotFoundException('Deal not found');
    return updated;
  }

  /** Gives many deals the same owner (or none) in one write. Returns how many
   * of the requested deals were found — a deal from another organization (or,
   * for a manager, another store) is simply not among them. */
  async assignOwnerBulk(ids: string[], organizationId: string, ownerId: string | null, storeId?: string): Promise<{ requested: number; assigned: number }> {
    const unique = [...new Set(ids)];
    const filter = { _id: { $in: unique }, organizationId, ...(storeId ? { storeId } : {}) };
    const update = ownerId ? { $set: { ownerId, ownerAssignedManually: true } } : { $unset: { ownerId: '', ownerAssignedManually: '' } };
    const result = await this.dealModel.updateMany(filter, update).exec();
    return { requested: unique.length, assigned: result.matchedCount };
  }

  create(organizationId: string, dto: CreateDealDto, storeConstraint?: string) {
    return this.dealModel.create({ organizationId, ...dto, storeId: storeConstraint ?? dto.storeId });
  }

  async update(id: string, organizationId: string, dto: UpdateDealDto, storeConstraint?: string) {
    const filter = { _id: id, organizationId, ...(storeConstraint ? { storeId: storeConstraint } : {}) };
    // lostReasonSource is never client-settable (see UpdateDealDto's
    // comment) — server-stamped 'rep_reported' the moment a real reason
    // arrives, reserving 'ai_inferred' for a future inference job only.
    let update: Record<string, unknown> = dto.lostReason?.trim() ? { ...dto, lostReasonSource: 'rep_reported' as const } : { ...dto };

    // expectedClosingDate is the only "closed date" this app has (see
    // sales-analytics.service.ts's own comment — every revenue/achievement
    // widget attributes a won deal to a month via this field's "YYYY-MM"
    // prefix). Left alone, a deal marked won/lost today keeps whatever
    // forecast date it had at creation, silently misattributing or hiding
    // real revenue from the month it actually closed in. Only stamps
    // "today" when the caller didn't already send an explicit new date in
    // this same request — an explicit correction is always respected.
    if ((dto.dealStatus === 'won' || dto.dealStatus === 'lost') && dto.expectedClosingDate === undefined) {
      update = { ...update, expectedClosingDate: new Date().toISOString().slice(0, 10) };
    }

    const updated = await this.dealModel.findOneAndUpdate(filter, { $set: update }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Deal not found');
    return updated;
  }

  async findOne(id: string, organizationId: string, storeConstraint?: string) {
    const filter = { _id: id, organizationId, ...(storeConstraint ? { storeId: storeConstraint } : {}) };
    const deal = await this.dealModel.findOne(filter).exec();
    if (!deal) throw new NotFoundException('Deal not found');
    return deal;
  }

  // extraMatch merges additional raw Mongo conditions on top of the
  // filter-derived match — used by deal-owner-mapping.service.ts's
  // listDealsForAssignment to add its "needs mapping" condition (a real
  // condition on the ownerId field, not a DealFilterQueryDto concept every
  // other caller of this method should have to know about) without
  // duplicating this method's own pagination logic.
  async listFiltered(organizationId: string, query: ListDealsQueryDto, storeConstraint?: string, extraMatch?: FilterQuery<Deal>) {
    const match = { ...buildDealMatchStage(organizationId, query, storeConstraint), ...extraMatch };
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const sortBy = query.sortBy ?? 'expectedClosingDate';
    const sortDir = query.sortDir === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
      this.dealModel
        .find(match)
        .sort({ [sortBy]: sortDir })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.dealModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize };
  }

  // Ignores client-supplied pagination — export always pulls up to `cap`
  // rows in one pass, with an explicit truncated flag rather than a silent
  // partial result.
  async listForExport(organizationId: string, filters: DealFilterQueryDto, storeConstraint: string | undefined, cap: number) {
    const match = buildDealMatchStage(organizationId, filters, storeConstraint);
    const items = await this.dealModel
      .find(match)
      .sort({ expectedClosingDate: -1 })
      .limit(cap + 1)
      .exec();
    const truncated = items.length > cap;
    return { items: truncated ? items.slice(0, cap) : items, truncated };
  }
}
