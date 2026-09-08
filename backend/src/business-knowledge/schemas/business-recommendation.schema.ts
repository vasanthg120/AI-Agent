import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BusinessRecommendationDocument = BusinessRecommendation & Document<Types.ObjectId>;

export const RECOMMENDATION_PRIORITIES = ['high', 'medium', 'low', 'opportunity'] as const;
export type RecommendationPriority = (typeof RECOMMENDATION_PRIORITIES)[number];

export const RECOMMENDATION_STATUSES = ['open', 'in_progress', 'completed', 'dismissed'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

// Rule-based v1 (see business-knowledge-insights.service.ts's REGENERATION_RULES) —
// every row here is generated deterministically from a completeness gap, never
// an LLM inventing a recommendation. `ruleKey` is stable per gap (the
// BusinessProfile field name the gap is about, e.g. "refundPolicy") so
// re-running the gap analysis upserts the same row instead of duplicating,
// and so a rule can auto-resolve itself once the underlying gap closes.
@Schema({ timestamps: true, collection: 'business_recommendations' })
export class BusinessRecommendation {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  ruleKey: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  category: string;

  @Prop({ required: true, enum: RECOMMENDATION_PRIORITIES })
  priority: RecommendationPriority;

  @Prop({ required: true })
  reason: string;

  @Prop()
  evidence?: string;

  @Prop()
  impact?: string;

  @Prop({ required: true })
  recommendedAction: string;

  @Prop({ required: true, enum: RECOMMENDATION_STATUSES, default: 'open', index: true })
  status: RecommendationStatus;

  // Set whenever status changes — including the system's own auto-complete
  // when a gap closes on its own — so "when did this actually get fixed" is
  // never ambiguous with createdAt/updatedAt (which timestamps:true already
  // bumps on every field touch, not just status changes).
  @Prop()
  statusChangedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const BusinessRecommendationSchema = SchemaFactory.createForClass(BusinessRecommendation);
BusinessRecommendationSchema.index({ organizationId: 1, ruleKey: 1 }, { unique: true });
BusinessRecommendationSchema.index({ organizationId: 1, status: 1 });
