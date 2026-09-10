import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProviderPricingDocument = ProviderPricing & Document<Types.ObjectId>;

// Versioned rate registry — the margin engine's source of truth. Seeded at
// migration time from python-agent/app/observability/cost.py's static
// constants (Anthropic $3/$15 per MTok, Groq $0.59/$0.79) as day-0
// defaults; that file's own estimate remains in place unchanged as the
// settlement fallback for any (provider, model) with no matching row here
// (see ReservationService.settle) — pricing gaps degrade gracefully rather
// than blocking a charge.
//
// model: '*' means "default for this provider, any model". effectiveTo:
// null means "currently active" — historical requests keep resolving to
// whichever row was active at their occurredAt, so a price change never
// rewrites past accounting.
@Schema({ timestamps: true, collection: 'provider_pricing' })
export class ProviderPricing {
  @Prop({ required: true, index: true })
  provider: string;

  @Prop({ required: true, default: '*' })
  model: string;

  @Prop({ required: true })
  inputCostPerMTokUsd: number;

  @Prop({ required: true })
  outputCostPerMTokUsd: number;

  @Prop({ required: true, index: true })
  effectiveFrom: Date;

  // Explicit `type: Date` since @nestjs/mongoose can't infer a Mongoose
  // type from TS reflection for a `Date | null` union (emitDecoratorMetadata
  // collapses it to Object) — without this the app fails at boot with
  // "CannotDetermineTypeError: Cannot determine a type for the
  // ProviderPricing.effectiveTo field".
  @Prop({ type: Date, default: null, index: true })
  effectiveTo: Date | null;

  // Optional per-(provider, model) override of the global target gross
  // margin, as a 0-100 percentage — unset means "use BillingSettings.
  // targetGrossMarginPct / the TARGET_GROSS_MARGIN env default", same
  // resolution PricingService.getTargetGrossMargin() already does for the
  // global value. Read by ReservationService.settle() per usage group,
  // never collapsed into one blended margin across groups with different
  // providers/models.
  @Prop({ min: 0, max: 99.99 })
  marginOverridePct?: number;
}

export const ProviderPricingSchema = SchemaFactory.createForClass(ProviderPricing);
ProviderPricingSchema.index({ provider: 1, model: 1, effectiveFrom: -1 });
