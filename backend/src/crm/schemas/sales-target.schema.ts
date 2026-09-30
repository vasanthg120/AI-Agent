import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SalesTargetDocument = SalesTarget & Document<Types.ObjectId>;

@Schema({ timestamps: true, collection: 'sales_targets' })
export class SalesTarget {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, enum: ['org', 'store', 'user'] })
  scope: 'org' | 'store' | 'user';

  @Prop()
  storeId?: string;

  @Prop()
  userId?: string;

  // "YYYY-MM" — same string-month pattern as DailyReport.date's "YYYY-MM-DD".
  @Prop({ required: true, index: true })
  period: string;

  @Prop({ required: true })
  targetAmount: number;

  @Prop({ default: 'INR' })
  currency: string;
}

export const SalesTargetSchema = SchemaFactory.createForClass(SalesTarget);
// One target per (org, scope, storeId/userId, period) — storeId/userId are
// both absent for scope:'org', so this also correctly rejects two org-level
// targets for the same period.
SalesTargetSchema.index({ organizationId: 1, scope: 1, storeId: 1, userId: 1, period: 1 }, { unique: true });
