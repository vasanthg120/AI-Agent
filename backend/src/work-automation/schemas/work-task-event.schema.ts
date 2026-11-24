import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export type WorkTaskEventDocument = WorkTaskEvent & Document<Types.ObjectId>;

export const TASK_EVENT_TYPES = ['created', 'updated', 'status_changed', 'completed', 'reassigned', 'deactivated', 'reactivated', 'verification_requested'] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

// Append-only activity history of a work task: what changed, when, and who or
// what caused it ('sync:crm', a user id, ...). Rows are only ever inserted.
@Schema({ timestamps: { createdAt: 'at', updatedAt: false }, collection: 'work_task_events' })
export class WorkTaskEvent {
  @Prop({ required: true, index: true }) organizationId: string;
  @Prop({ required: true, index: true }) taskId: string;
  @Prop({ required: true, index: true }) userId: string;
  @Prop({ required: true, enum: TASK_EVENT_TYPES }) type: TaskEventType;
  @Prop({ required: true }) actor: string;
  @Prop({ type: SchemaTypes.Mixed }) from?: unknown;
  @Prop({ type: SchemaTypes.Mixed }) to?: unknown;
  @Prop() note?: string;
  at: Date;
}

export const WorkTaskEventSchema = SchemaFactory.createForClass(WorkTaskEvent);
WorkTaskEventSchema.index({ organizationId: 1, userId: 1, at: -1 });
WorkTaskEventSchema.index({ taskId: 1, at: 1 });
