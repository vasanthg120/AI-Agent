import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UsageRecordDocument = UsageRecord & Document<Types.ObjectId>;

// Per-org, per-period usage rollup — separate from any payment/wallet
// concept, matching the spec's "a UsageRecord model separate from payment"
// requirement. Populated by EntitlementsUsageAggregationService reading the
// existing agent_executions collection (python-agent's raw per-LLM-call
// trace); nothing here is written by, or read by, the wallet/reservation
// path — this is purely the read side EntitlementsService.canAccess uses to
// compare usage against a plan's numeric entitlement grants.
//
// Phase 0 scoping note: the aggregation job currently buckets every chat
// turn under the single feature key 'ai_usage' (total input+output tokens
// across all models, per org per calendar day) — agent_executions has no
// per-entitlement-key tag to aggregate by. A numeric entitlement's grant
// only produces a meaningful usage-vs-limit comparison today when its
// catalog key is exactly 'ai_usage'; other numeric entitlement keys simply
// have no matching UsageRecord rows yet. Extending the aggregation to
// multiple feature buckets is future work, not attempted here.
@Schema({ collection: 'usage_records' })
export class UsageRecord {
  @Prop({ required: true, index: true })
  organizationId: string;

  // Not populated by the aggregation job today (a day's usage can span more
  // than one subscription if a plan changes mid-day) — kept optional so a
  // future write path that does know the subscription at write time can set
  // it without a schema change.
  @Prop()
  subscriptionId?: string;

  @Prop({ required: true, index: true })
  feature: string;

  @Prop({ type: String, default: null })
  model: string | null;

  @Prop({ default: 0 })
  inputUnits: number;

  @Prop({ default: 0 })
  outputUnits: number;

  @Prop({ default: 0 })
  totalUnits: number;

  @Prop({ required: true, index: true })
  periodStart: Date;

  @Prop({ required: true })
  periodEnd: Date;

  @Prop({ default: () => new Date() })
  createdAt: Date;
}

export const UsageRecordSchema = SchemaFactory.createForClass(UsageRecord);
UsageRecordSchema.index({ organizationId: 1, feature: 1, model: 1, periodStart: 1 }, { unique: true });
