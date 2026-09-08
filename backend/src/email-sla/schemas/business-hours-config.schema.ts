import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BusinessHoursConfigDocument = BusinessHoursConfig & Document<Types.ObjectId>;

// One per organization — additive, doesn't touch Organization/Store's own
// schemas (Store already has openingTime/closingTime/timezone, but those
// drive daily-report scheduling, a different feature; SLA math needs its
// own explicit, admin-configurable calendar so the two are never
// accidentally coupled). `workingDays` uses JS's own 0=Sunday..6=Saturday
// convention throughout this module (email-sla-calculator.service.ts).
@Schema({ timestamps: true, collection: 'email_sla_business_hours_configs' })
export class BusinessHoursConfig {
  @Prop({ required: true, unique: true, index: true })
  organizationId: string;

  // IANA zone name (e.g. "Asia/Kolkata") — resolved via Intl.DateTimeFormat
  // in the calculator, no date-library dependency needed.
  @Prop({ required: true, default: 'UTC' })
  timezone: string;

  @Prop({ type: [Number], default: [1, 2, 3, 4, 5] })
  workingDays: number[];

  // "HH:mm" 24-hour, evaluated in `timezone` above.
  @Prop({ required: true, default: '09:00' })
  workingStartTime: string;

  @Prop({ required: true, default: '18:00' })
  workingEndTime: string;

  // Plain "YYYY-MM-DD" dates, evaluated in `timezone` — a whole calendar day
  // off, not a UTC-instant range.
  @Prop({ type: [String], default: [] })
  holidays: string[];

  createdAt: Date;
  updatedAt: Date;
}

export const BusinessHoursConfigSchema = SchemaFactory.createForClass(BusinessHoursConfig);
