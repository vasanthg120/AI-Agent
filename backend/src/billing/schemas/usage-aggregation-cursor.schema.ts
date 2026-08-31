import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UsageAggregationCursorDocument = UsageAggregationCursor & Document<Types.ObjectId>;

// Single-row bookmark for EntitlementsUsageAggregationService — tracks the
// last agent_executions._id processed so each hourly cron tick only
// aggregates rows created since the previous run (agent_executions has no
// other monotonic field safe to page on across a long-running collection).
// Advancing this cursor is the sole thing that makes re-running the
// aggregation safe: a doc's tokens are only ever $inc'd into a UsageRecord
// bucket once, the run after its _id has passed the cursor.
@Schema({ collection: 'billing_usage_aggregation_cursor' })
export class UsageAggregationCursor {
  @Prop({ required: true, unique: true, default: 'default' })
  key: string;

  @Prop()
  lastProcessedExecutionId?: string;
}

export const UsageAggregationCursorSchema = SchemaFactory.createForClass(UsageAggregationCursor);
