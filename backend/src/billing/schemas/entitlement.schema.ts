import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EntitlementDocument = Entitlement & Document<Types.ObjectId>;

export const ENTITLEMENT_TYPES = ['boolean', 'numeric'] as const;
export type EntitlementType = (typeof ENTITLEMENT_TYPES)[number];

// Catalog of "can this org access feature X" capabilities — platform-global,
// no organizationId, same precedent as BillingFeature. Distinct from
// BillingFeature (a plain display label with no semantics of its own):
// an Entitlement carries a real type, so EntitlementsService.canAccess can
// answer a boolean yes/no or a numeric usage-vs-limit question, matching the
// spec's "ask the app 'can this user access feature X', not 'is this user on
// Plus'" requirement. A plan grants an entitlement via BillingPlan.entitlements
// (see billing-plan.schema.ts) referencing this catalog's key by value, same
// no-populate string-key convention used throughout this module.
@Schema({ timestamps: true, collection: 'billing_entitlements' })
export class Entitlement {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  name: string;

  // Immutable after creation in practice (see BillingAdminEntitlementsService
  // — update never touches this field): changing what a key *means*
  // mid-flight would silently invalidate every plan grant and UsageRecord
  // already keyed against it.
  @Prop({ required: true, enum: ENTITLEMENT_TYPES })
  type: EntitlementType;

  @Prop()
  description?: string;

  @Prop({ default: true, index: true })
  active: boolean;
}

export const EntitlementSchema = SchemaFactory.createForClass(Entitlement);
