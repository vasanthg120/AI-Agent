import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PaymentProviderKey } from '../providers/payment-provider.interface';

export type RefundDocument = Refund & Document<Types.ObjectId>;

// One row per refund ATTEMPT (including failed ones — an admin retrying a
// failed refund produces a second row, not a mutation of the first),
// against the same gateway the original PaymentRecord captured through.
// This is the audit trail; PaymentRecord.refundedAmount is the running
// total RefundService derives from every 'succeeded' row here.
@Schema({ timestamps: true, collection: 'billing_refunds' })
export class Refund {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  paymentRecordId: string;

  @Prop({ required: true, enum: ['razorpay', 'stripe', 'cashfree'] })
  provider: PaymentProviderKey;

  @Prop()
  gatewayRefundId?: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string;

  // How many Haive Credits this refund clawed back from the wallet — a
  // proportional share of the original PaymentRecord.creditsGranted (see
  // RefundService), 0 if the refund failed before any wallet write happened.
  @Prop({ default: 0 })
  creditsClawedBack: number;

  @Prop()
  reason?: string;

  @Prop({ required: true, enum: ['succeeded', 'failed'], index: true })
  status: 'succeeded' | 'failed';

  @Prop({ default: false })
  simulated: boolean;

  @Prop({ required: true })
  createdBy: string;
}

export const RefundSchema = SchemaFactory.createForClass(Refund);
RefundSchema.index({ organizationId: 1, createdAt: -1 });
