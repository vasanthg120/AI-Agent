import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProviderAlertLogDocument = ProviderAlertLog & Document;

// One row per alert ProviderAlertService actually sent — the dashboard's
// "recent alerts" feed reads the latest N of these rather than re-deriving
// history from current state (which only ever shows the LATEST status, not
// what fired and when).
@Schema({ collection: 'provider_alert_logs', timestamps: true })
export class ProviderAlertLog {
  @Prop({ required: true, index: true })
  provider: string;

  @Prop({ required: true })
  alertType: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  message: string;
}

export const ProviderAlertLogSchema = SchemaFactory.createForClass(ProviderAlertLog);
ProviderAlertLogSchema.index({ createdAt: -1 });
