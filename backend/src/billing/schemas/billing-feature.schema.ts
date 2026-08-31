import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingFeatureDocument = BillingFeature & Document<Types.ObjectId>;

// Catalog of feature labels a BillingPlan.features[] entry can reference by
// key — platform-global, no organizationId, same precedent as CreditPackage.
// Exists purely so the admin Plans UI has real labels/categories to pick
// from; a plan's actual feature grants live embedded on BillingPlan itself
// (see that schema's own comment for why), not here.
@Schema({ timestamps: true, collection: 'billing_features' })
export class BillingFeature {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  category?: string;

  @Prop({ default: true, index: true })
  active: boolean;
}

export const BillingFeatureSchema = SchemaFactory.createForClass(BillingFeature);
