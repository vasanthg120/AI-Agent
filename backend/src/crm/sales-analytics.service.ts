import { BadRequestException, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { scopeCurrency } from '../data-sources/scope-currency';
import { Deal, DealDocument } from './schemas/deal.schema';
import { SalesTarget, SalesTargetDocument } from './schemas/sales-target.schema';
import { UpsertSalesTargetDto } from './dto/upsert-sales-target.dto';

export interface Achievement {
  period: string;
  targetAmount: number | null;
  currency: string;
  achieved: number;
  achievementPct: number | null;
  remaining: number | null;
  avgDailySalesNeeded: number | null;
  predictedMonthEnd: number;
  forecastConfidence: number;
}

function daysInMonth(period: string): number {
  const [year, month] = period.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

/** Days of `period` that have elapsed as of now — daysInMonth for a past
 * period, 0 for a future one, today's day-of-month for the current one. */
function daysElapsed(period: string): number {
  const [year, month] = period.split('-').map(Number);
  const now = new Date();
  const total = daysInMonth(period);
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return total;
  if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1)) return 0;
  return now.getDate();
}

@Injectable()
export class SalesAnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(SalesAnalyticsService.name);

  constructor(
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(SalesTarget.name) private targetModel: Model<SalesTargetDocument>,
    // Targets are in a currency: only those in the shown CRM's apply (see resolveTarget).
    @Optional() @InjectConnection() private connection?: Connection,
  ) {}

  /** Targets used to be one per store/person and month; now one per currency too
   * (schema index). The old unique index would refuse a second currency's target. */
  async onModuleInit(): Promise<void> {
    if (!this.connection) return;
    try {
      const indexes = await this.connection.collection('sales_targets').indexes();
      if (indexes.some((i) => i.name === 'organizationId_1_scope_1_storeId_1_userId_1_period_1')) {
        await this.connection.collection('sales_targets').dropIndex('organizationId_1_scope_1_storeId_1_userId_1_period_1');
        this.logger.log('Sales targets are now one per currency as well (old unique index replaced).');
      }
    } catch (err) {
      // Collection not created yet — nothing to replace.
      if (!/ns not found|NamespaceNotFound/i.test((err as Error).message)) this.logger.warn(`Sales target index: ${(err as Error).message}`);
    }
  }

  /** The shown CRM's currency (Pantheras INR, Hoops AUD); undefined where there's no connection to ask (tests). */
  private shownCurrency(organizationId: string): Promise<string | undefined> {
    return this.connection ? scopeCurrency(this.connection, organizationId) : Promise.resolve(undefined);
  }

  async upsertTarget(organizationId: string, dto: UpsertSalesTargetDto) {
    if (dto.scope === 'store' && !dto.storeId) throw new BadRequestException('storeId is required for scope "store"');
    if (dto.scope === 'user' && !dto.userId) throw new BadRequestException('userId is required for scope "user"');

    const filter = {
      organizationId,
      scope: dto.scope,
      storeId: dto.scope === 'store' ? dto.storeId : undefined,
      userId: dto.scope === 'user' ? dto.userId : undefined,
      period: dto.period,
      // One target per store/person, month and currency: a rupee target for Pantheras CRM and an AUD one for Hoops CRM live side by side.
      currency: (dto.currency ?? 'INR').toUpperCase(),
    };
    return this.targetModel.findOneAndUpdate(filter, { ...filter, targetAmount: dto.targetAmount }, { upsert: true, new: true }).exec();
  }

  listTargets(organizationId: string, period?: string, currency?: string) {
    return this.targetModel.find({ organizationId, ...(period ? { period } : {}), ...(currency ? { currency: currency.toUpperCase() } : {}) }).exec();
  }

  /** Achievement %, remaining target, average daily sales still needed, and a
   * simple linear month-end projection — deliberately not a real forecasting
   * model (see plan notes): `achieved / daysElapsed * daysInMonth`, with a
   * coarse days-elapsed-ratio confidence score. Won deals are attributed to
   * the period via `expectedClosingDate`'s "YYYY-MM" prefix, a pragmatic
   * proxy in the absence of a separate "closed at" timestamp. */
  async getAchievement(
    organizationId: string,
    scope: 'org' | 'store' | 'user',
    scopeId: string | undefined,
    period: string,
  ): Promise<Achievement> {
    const dealFilter: Record<string, unknown> = {
      organizationId,
      dealStatus: 'won',
      expectedClosingDate: { $regex: `^${period}` },
    };
    if (scope === 'store') dealFilter.storeId = scopeId;
    if (scope === 'user') dealFilter.ownerId = scopeId;

    const [{ achieved = 0 } = {}, { targetAmount, currency }] = await Promise.all([
      this.dealModel
        .aggregate<{ achieved: number }>([
          { $match: dealFilter },
          { $group: { _id: null, achieved: { $sum: '$monetaryValue' } } },
        ])
        .exec()
        .then((rows) => rows[0]),
      this.resolveTarget(organizationId, scope, scopeId, period),
    ]);

    const totalDays = daysInMonth(period);
    const elapsed = daysElapsed(period);
    const remainingDays = Math.max(totalDays - elapsed, 0);

    const remaining = targetAmount !== null ? Math.max(targetAmount - achieved, 0) : null;
    return {
      period,
      targetAmount,
      currency,
      achieved,
      achievementPct: targetAmount ? Math.round((achieved / targetAmount) * 1000) / 10 : null,
      remaining,
      avgDailySalesNeeded: remaining !== null ? Math.round((remaining / (remainingDays || 1)) * 100) / 100 : null,
      predictedMonthEnd: elapsed > 0 ? Math.round((achieved / elapsed) * totalDays * 100) / 100 : achieved,
      forecastConfidence: Math.round((elapsed / totalDays) * 100) / 100,
    };
  }

  // There is no standalone org-level target to set (Settings → Sales
  // Targets only ever offers Store and Employee targets — see
  // SalesTargetsSettings.tsx) — an org's target is the sum of every store's
  // target for the period instead. Store/user scope still read their own
  // single target document exactly as before. Currency is taken from
  // whichever store target happens to be first; every target in this app
  // is created with a fixed 'INR' default (UpsertSalesTargetDto), so this
  // never actually varies in practice.
  private async resolveTarget(
    organizationId: string,
    scope: 'org' | 'store' | 'user',
    scopeId: string | undefined,
    period: string,
  ): Promise<{ targetAmount: number | null; currency: string }> {
    // Only targets in the shown CRM's currency: a rupee target is never measured against AUD sales.
    const currency = await this.shownCurrency(organizationId);
    const inCurrency = currency ? { currency } : {};
    if (scope === 'org') {
      const storeTargets = await this.targetModel.find({ organizationId, scope: 'store', period, ...inCurrency }).exec();
      if (storeTargets.length === 0) return { targetAmount: null, currency: currency ?? 'INR' };
      return {
        targetAmount: storeTargets.reduce((sum, t) => sum + t.targetAmount, 0),
        currency: storeTargets[0].currency ?? 'INR',
      };
    }
    const target = await this.targetModel
      .findOne({
        organizationId,
        scope,
        storeId: scope === 'store' ? scopeId : undefined,
        userId: scope === 'user' ? scopeId : undefined,
        period,
        ...inCurrency,
      })
      .exec();
    return { targetAmount: target?.targetAmount ?? null, currency: target?.currency ?? currency ?? 'INR' };
  }
}
