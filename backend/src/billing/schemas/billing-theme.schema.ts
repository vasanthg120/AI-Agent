import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingThemeDocument = BillingTheme & Document<Types.ObjectId>;

// Singleton (see BillingSettings for the identical singletonKey pattern).
// `tokens`/`darkTokens` are free-form CSS-custom-property maps, deliberately
// NOT one hardcoded field per color (primaryColor, secondaryColor, ...) —
// the frontend's useBillingTheme hook injects whatever keys are present as
// inline `--billing-*`-prefixed custom properties scoped to the pricing
// page, so new tokens can be added on either side without a schema
// migration. Empty/absent means "use the static fallback" (see
// frontend/src/styles/variables.css's own token set) — a misconfigured or
// never-touched theme never breaks the page.
@Schema({ timestamps: true, collection: 'billing_theme' })
export class BillingTheme {
  @Prop({ required: true, unique: true, default: 'default' })
  singletonKey: string;

  @Prop({ type: Object, default: {} })
  tokens: Record<string, string>;

  @Prop({ type: Object, default: {} })
  darkTokens: Record<string, string>;

  @Prop()
  logoUrl?: string;

  @Prop()
  faviconUrl?: string;
}

export const BillingThemeSchema = SchemaFactory.createForClass(BillingTheme);
