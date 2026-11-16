import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SquareWebhookEventDocument = SquareWebhookEvent & Document<Types.ObjectId>;

// The idempotency anchor for Square webhook deliveries — same shape as
// billing/schemas/webhook-event.schema.ts's Razorpay-only collection, but
// its own, separate collection: that one's `provider` field is hardcoded to
// the literal type 'razorpay', so reusing it for Square would need a
// breaking type change there. Square itself documents "webhooks can be sent
// more than once," with retries for up to 24h — a duplicate delivery hits a
// Mongo duplicate-key error on insert and is dropped before any processing.
//
// eventId is globally unique (Square's own id, not scoped per-organization
// — confirmed via Square's webhook docs), so the dedup index is on eventId
// alone; organizationId is stored alongside purely for traceability/
// filtering, never part of the uniqueness.
@Schema({ timestamps: { createdAt: 'receivedAt', updatedAt: false }, collection: 'square_webhook_events' })
export class SquareWebhookEvent {
  @Prop({ required: true, unique: true })
  eventId: string;

  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  eventType: string;

  @Prop({ type: Object, required: true })
  payload: Record<string, unknown>;

  // Phase A processes payment.updated/refund.* synchronously inside the
  // same request that verifies and stores the event — this flags whether
  // that processing actually succeeded, so a failed handler can be
  // re-attempted (by the periodic reconciliation pass, which re-reads
  // Square directly rather than retrying this exact row) without ever
  // reprocessing a row that already succeeded.
  @Prop({ default: false })
  processed: boolean;

  @Prop()
  processingError?: string;

  @Prop()
  receivedAt: Date;
}

export const SquareWebhookEventSchema = SchemaFactory.createForClass(SquareWebhookEvent);
