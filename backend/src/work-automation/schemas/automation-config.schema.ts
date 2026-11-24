import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AutomationConfigDocument = AutomationConfig & Document<Types.ObjectId>;

// Per-organization settings of the automatic To-Do & EOD system. Everything is
// optional here: a missing value falls back to DEFAULT_AUTOMATION_CONFIG, so a
// new setting never needs a migration.
@Schema({ timestamps: true, collection: 'work_automation_configs' })
export class AutomationConfig {
  @Prop({ required: true, unique: true, index: true }) organizationId: string;
  @Prop() enabled?: boolean;
  @Prop() eodTime?: string;
  @Prop() timezone?: string;
  @Prop({ type: [String], default: undefined }) enabledSources?: string[];
  @Prop({ type: [String], default: undefined }) crmProviders?: string[];
  @Prop() staleDealDays?: number;
  @Prop() dealCloseWindowDays?: number;
  @Prop() quoteDueWindowDays?: number;
  @Prop() emailLookbackDays?: number;
  @Prop() syncOnLoginMinIntervalMin?: number;
  @Prop() sendToManager?: boolean;
  @Prop({ type: [String], default: undefined }) deliveryChannels?: string[];
  @Prop() maxDeliveryAttempts?: number;
  @Prop() updatedBy?: string;
}

export const AutomationConfigSchema = SchemaFactory.createForClass(AutomationConfig);
