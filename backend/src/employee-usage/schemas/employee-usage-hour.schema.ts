import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmployeeUsageHourDocument = EmployeeUsageHour & Document<Types.ObjectId>;

/** Kept for 13 months: a year's comparison, and no older. */
export const USAGE_RETENTION_SECONDS = 400 * 24 * 60 * 60;

// One person's measured use of HaiVE in one hour (UTC): for each minute, the
// seconds they were really active in each part of the app (see usage-areas).
// "Active" is decided in the browser: the HaiVE tab in front, its window
// focused, and a click, key press, scroll or touch in the last two minutes —
// an open tab nobody touches counts for nothing.
//
// Written with $max per minute and part: the browser sends running totals, so
// a retry, a beat sent twice, or two tabs on the same page never add up twice.
// Two parts in one minute (two devices at once) are capped at 60 seconds when
// read (EmployeeUsageService.measure).
@Schema({ collection: 'employee_usage_hours', versionKey: false, minimize: false })
export class EmployeeUsageHour {
  @Prop({ required: true })
  organizationId: string;

  // The member record working in that business (JwtPayload.sub).
  @Prop({ required: true })
  userId: string;

  // Start of the UTC hour.
  @Prop({ required: true })
  hour: Date;

  // Minute "00"–"59" → area → active seconds (1–60).
  @Prop({ type: Object, default: {} })
  m: Record<string, Record<string, number>>;

  @Prop()
  firstAt?: Date;

  @Prop()
  lastAt?: Date;
}

export const EmployeeUsageHourSchema = SchemaFactory.createForClass(EmployeeUsageHour);
EmployeeUsageHourSchema.index({ organizationId: 1, userId: 1, hour: 1 }, { unique: true });
EmployeeUsageHourSchema.index({ hour: 1 }, { expireAfterSeconds: USAGE_RETENTION_SECONDS });
