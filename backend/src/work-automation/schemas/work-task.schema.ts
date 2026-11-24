import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';
import { EVIDENCE_TYPES, TASK_PRIORITIES, TASK_STATUSES } from '../task-types';
import type { CompletionEvidence, TaskPriority, TaskStatus } from '../task-types';

export type WorkTaskDocument = WorkTask & Document<Types.ObjectId>;

// A sub-schema class rather than an inline object: a nested field called "type"
// is read by Mongoose as the schema type declaration and silently drops the rest.
@Schema({ _id: false })
class CompletionEvidenceDoc {
  @Prop({ required: true, enum: EVIDENCE_TYPES }) type: string;
  @Prop({ required: true }) detail: string;
  @Prop({ required: true }) at: Date;
  @Prop() sourceRef?: string;
  @Prop() verifiedBy?: string;
}
const CompletionEvidenceSchema = SchemaFactory.createForClass(CompletionEvidenceDoc);

// One unit of assigned work, collected from a source platform. Distinct from the
// legacy DailyReport task board (dashboard/), which stays as it is. The natural
// key (organizationId, sourcePlatform, sourceType, sourceRecordId) is unique, so
// the same source record can never become two tasks however often it is synced.
@Schema({ timestamps: true, collection: 'work_tasks' })
export class WorkTask {
  @Prop({ required: true, index: true }) organizationId: string;
  // The Haive user this work belongs to. Only ever set from a verified identity.
  @Prop({ required: true, index: true }) assignedTo: string;

  @Prop({ required: true }) sourcePlatform: string;
  @Prop({ required: true }) sourceType: string;
  @Prop({ required: true }) sourceRecordId: string;
  @Prop() sourceUrl?: string;
  // The source's own status wording, kept for transparency (never interpreted by AI).
  @Prop() sourceStatus?: string;
  @Prop() sourceUpdatedAt?: Date;

  @Prop({ required: true }) title: string;
  @Prop() description?: string;
  @Prop({ required: true, enum: TASK_PRIORITIES, default: 'medium' }) priority: TaskPriority;
  @Prop() dueDate?: Date;
  @Prop({ required: true, enum: TASK_STATUSES, default: 'pending', index: true }) status: TaskStatus;

  // Hidden from the To-Do list but kept for history: the source reassigned it,
  // withdrew it, or it stopped being actionable. Never silently deleted.
  @Prop({ default: true, index: true }) isActive: boolean;
  @Prop() inactiveReason?: string;

  // Proof of completion. A task is only 'completed' when this is present.
  @Prop({ type: CompletionEvidenceSchema, _id: false })
  completionEvidence?: CompletionEvidence;
  @Prop() completedAt?: Date;

  // Free-form context for the EOD (e.g. customer name, amounts). Display only.
  @Prop({ type: SchemaTypes.Mixed, default: {} }) meta: Record<string, unknown>;

  @Prop() firstSyncedAt?: Date;
  @Prop() lastSyncedAt?: Date;
  // Bumped by every sync that saw the task as open in its source.
  @Prop() lastSeenOpenAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const WorkTaskSchema = SchemaFactory.createForClass(WorkTask);
WorkTaskSchema.index({ organizationId: 1, sourcePlatform: 1, sourceType: 1, sourceRecordId: 1 }, { unique: true });
WorkTaskSchema.index({ organizationId: 1, assignedTo: 1, isActive: 1, status: 1 });
WorkTaskSchema.index({ organizationId: 1, assignedTo: 1, dueDate: 1 });
