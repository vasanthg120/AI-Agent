import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WorkSyncRunDocument = WorkSyncRun & Document<Types.ObjectId>;
export type WorkSyncStateDocument = WorkSyncState & Document<Types.ObjectId>;

export const SYNC_TRIGGERS = ['login', 'schedule', 'eod', 'manual'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

// One adapter run: the integration synchronization monitor the admin page reads.
@Schema({ timestamps: true, collection: 'work_sync_runs' })
export class WorkSyncRun {
  @Prop({ required: true, index: true }) organizationId: string;
  @Prop({ index: true }) userId?: string; // absent = organization-wide
  @Prop({ required: true }) adapterId: string;
  @Prop({ required: true, enum: SYNC_TRIGGERS }) trigger: SyncTrigger;
  @Prop({ required: true, enum: ['ok', 'partial', 'failed'] }) status: 'ok' | 'partial' | 'failed';
  @Prop({ required: true }) startedAt: Date;
  @Prop({ required: true }) finishedAt: Date;
  @Prop({ default: 0 }) fetched: number;
  @Prop({ default: 0 }) created: number;
  @Prop({ default: 0 }) updated: number;
  @Prop({ default: 0 }) completed: number;
  @Prop({ default: 0 }) deactivated: number;
  @Prop({ default: 0 }) unresolved: number;
  @Prop() error?: string;
  createdAt: Date;
}

export const WorkSyncRunSchema = SchemaFactory.createForClass(WorkSyncRun);
WorkSyncRunSchema.index({ organizationId: 1, startedAt: -1 });
// Old run rows are monitoring data only.
WorkSyncRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

// Atomic claim record per (organization, scope): at most one sync of a scope
// runs at a time, and a login-triggered sync is skipped when one ran recently.
@Schema({ timestamps: true, collection: 'work_sync_state' })
export class WorkSyncState {
  @Prop({ required: true }) organizationId: string;
  // "org" or "user:<id>"
  @Prop({ required: true }) scopeKey: string;
  @Prop() lastStartedAt?: Date;
  @Prop() lastFinishedAt?: Date;
  @Prop() lockedUntil?: Date;
}

export const WorkSyncStateSchema = SchemaFactory.createForClass(WorkSyncState);
WorkSyncStateSchema.index({ organizationId: 1, scopeKey: 1 }, { unique: true });
