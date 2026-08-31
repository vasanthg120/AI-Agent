import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingPlanDocument = BillingPlan & Document<Types.ObjectId>;

// Embedded, not a separate collection — a plan's feature/limit set is always
// read together with the plan itself and changes atomically with it, same
// reasoning as Wallet.autoPay's embedded AutoPaySettings subdocument.
@Schema({ _id: false })
export class BillingPlanFeatureGrant {
  // References BillingFeature.key by value — no populate, same
  // string-key-not-ObjectId-ref convention used for organizationId
  // throughout this codebase.
  @Prop({ required: true })
  featureKey: string;

  @Prop({ default: true })
  enabled: boolean;

  // e.g. a numeric cap or a display string specific to this plan's version
  // of the feature (kept loose — the admin UI decides what's meaningful per
  // feature category).
  @Prop()
  valueOverride?: string;
}
const BillingPlanFeatureGrantSchema = SchemaFactory.createForClass(BillingPlanFeatureGrant);

@Schema({ _id: false })
export class BillingPlanLimitGrant {
  // Freeform key (e.g. "messages", "projects", "storage_gb") — no separate
  // limit-catalog collection exists; the admin UI is the source of truth for
  // which keys are meaningful, same freeform-key philosophy as
  // WalletTransaction.metadata.
  @Prop({ required: true })
  limitKey: string;

  @Prop({ default: false })
  unlimited: boolean;

  // Ignored when unlimited is true.
  @Prop()
  value?: number;
}
const BillingPlanLimitGrantSchema = SchemaFactory.createForClass(BillingPlanLimitGrant);

// Phase 0 of the ChatGPT-style entitlements migration (see
// entitlements.service.ts) — additive, parallel to features/limits above,
// which stay exactly as they are. References Entitlement.key by value, same
// no-populate convention as BillingPlanFeatureGrant.featureKey.
@Schema({ _id: false })
export class BillingPlanEntitlementGrant {
  @Prop({ required: true })
  key: string;

  // Boolean entitlements: this IS the grant (on/off). Numeric entitlements:
  // gates the grant independently of `value` — a numeric entitlement can be
  // present with enabled:false to explicitly deny it regardless of limit.
  @Prop({ default: true })
  enabled: boolean;

  // Numeric entitlements only: the plan's cap for this period (e.g. monthly
  // token limit). Omitted means unlimited. Ignored for boolean entitlements.
  @Prop()
  value?: number;
}
const BillingPlanEntitlementGrantSchema = SchemaFactory.createForClass(BillingPlanEntitlementGrant);

// Platform-global plan catalog (no organizationId — same precedent as
// CreditPackage/ProviderPricing). A plan's actual price(s) live in
// BillingPlanPrice (one plan can have several: per currency/billing cycle),
// versioned separately so a price change never rewrites history.
@Schema({ timestamps: true, collection: 'billing_plans' })
export class BillingPlan {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  shortDescription?: string;

  // Admin-only context — never returned by a customer-facing route.
  @Prop()
  internalDescription?: string;

  @Prop()
  icon?: string;

  @Prop()
  image?: string;

  @Prop()
  badgeText?: string;

  @Prop()
  badgeColor?: string;

  @Prop()
  planColor?: string;

  @Prop({ default: 0, index: true })
  sortOrder: number;

  @Prop({ default: true, index: true })
  active: boolean;

  // Distinct from `active`: an inactive plan is unselectable everywhere; an
  // active-but-not-public plan can still be assigned to an org manually
  // (e.g. a bespoke enterprise deal) without ever appearing on the public
  // pricing page.
  @Prop({ default: true, index: true })
  isPublic: boolean;

  @Prop({ default: false })
  recommended: boolean;

  @Prop()
  trialDays?: number;

  @Prop({ type: [BillingPlanFeatureGrantSchema], default: [] })
  features: BillingPlanFeatureGrant[];

  @Prop({ type: [BillingPlanLimitGrantSchema], default: [] })
  limits: BillingPlanLimitGrant[];

  @Prop({ type: [BillingPlanEntitlementGrantSchema], default: [] })
  entitlements: BillingPlanEntitlementGrant[];
}

export const BillingPlanSchema = SchemaFactory.createForClass(BillingPlan);
