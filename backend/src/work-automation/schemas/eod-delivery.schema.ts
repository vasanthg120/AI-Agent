import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export type EodDeliveryDocument = EodDelivery & Document<Types.ObjectId>;

export const DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryRole = 'employee' | 'manager' | 'admin';

export interface ChannelAttempt {
  channel: string;
  ok: boolean;
  error?: string;
  /** What the provider answered (python-agent's reply), kept for the delivery log. */
  response?: unknown;
  at: Date;
}

// One row per (report, role): the employee's copy and the manager's copy. The
// unique key is what prevents sending the same report to the same person twice.
@Schema({ timestamps: true, collection: 'work_eod_deliveries' })
export class EodDelivery {
  @Prop({ required: true, index: true }) organizationId: string;
  @Prop({ required: true, index: true }) reportId: string;
  // Whose mailbox the report is sent from, and who it is about.
  @Prop({ required: true }) employeeId: string;
  @Prop({ required: true, enum: ['employee', 'manager', 'admin'] }) role: DeliveryRole;
  @Prop() recipientUserId?: string;
  @Prop() recipientEmail?: string;
  // 'admin' rows: the connected mailbox that carries the report (null/absent = SMTP fallback only) and a
  // configuration warning for the organization admin (e.g. no mailbox connected).
  @Prop() recipientProvider?: string;
  @Prop() warning?: string;
  @Prop({ type: SchemaTypes.Mixed }) providerResponse?: unknown;

  @Prop({ required: true, enum: DELIVERY_STATUSES, default: 'pending', index: true }) status: DeliveryStatus;
  @Prop({ default: 0 }) attempts: number;
  @Prop() nextAttemptAt?: Date;
  @Prop() lockedAt?: Date;
  @Prop() sentAt?: Date;
  // The channel that finally carried it: gmail | outlook | smtp.
  @Prop() channel?: string;
  @Prop() lastError?: string;
  @Prop() skippedReason?: string;
  @Prop({ type: SchemaTypes.Mixed, default: [] }) channelAttempts: ChannelAttempt[];

  createdAt: Date;
  updatedAt: Date;
}

export const EodDeliverySchema = SchemaFactory.createForClass(EodDelivery);
EodDeliverySchema.index({ reportId: 1, role: 1 }, { unique: true });
EodDeliverySchema.index({ organizationId: 1, status: 1, nextAttemptAt: 1 });
