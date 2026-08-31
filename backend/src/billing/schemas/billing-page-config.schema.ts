import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingPageConfigDocument = BillingPageConfig & Document<Types.ObjectId>;

@Schema({ _id: false })
export class BillingFaqEntry {
  @Prop({ required: true })
  question: string;

  @Prop({ required: true })
  answer: string;
}
const BillingFaqEntrySchema = SchemaFactory.createForClass(BillingFaqEntry);

// Singleton (see BillingSettings/BillingTheme for the identical
// singletonKey pattern) — the public pricing page's copy and curated plan
// order. `displayedPlanIds` is deliberately independent of
// BillingPlan.sortOrder: the admin catalog's natural order (used by e.g. a
// future admin plan-list view) doesn't have to match what's actually
// showcased on the marketing page, and an empty array means "show every
// active+isPublic plan in its own sortOrder" — never an empty page just
// because this hasn't been touched yet.
@Schema({ timestamps: true, collection: 'billing_page_config' })
export class BillingPageConfig {
  @Prop({ required: true, unique: true, default: 'default' })
  singletonKey: string;

  @Prop()
  heroHeadline?: string;

  @Prop()
  heroSubtext?: string;

  @Prop({ default: 'Get Started' })
  ctaButtonText: string;

  @Prop({ type: [BillingFaqEntrySchema], default: [] })
  faqEntries: BillingFaqEntry[];

  @Prop({ type: [String], default: [] })
  displayedPlanIds: string[];
}

export const BillingPageConfigSchema = SchemaFactory.createForClass(BillingPageConfig);
