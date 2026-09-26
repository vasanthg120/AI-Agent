import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrganizationDocument = Organization & Document<Types.ObjectId>;

// The tenant boundary. Every org-scoped collection (User, Store,
// IntegrationCredential, AgentRole, DailyReport, ...) carries this id and
// every service-layer query must filter on it — this is what makes the
// deployment multi-tenant rather than a single shared business.
@Schema({ timestamps: true, collection: 'organizations' })
export class Organization {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, index: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ enum: ['active', 'suspended'], default: 'active' })
  status: 'active' | 'suspended';

  // Tenant-level ceiling on notification delivery, not a default — the
  // effective send decision is this AND the target user's own
  // notificationPreferences (see user.schema.ts). An owner/admin can hard-
  // disable a channel org-wide (no SMTP configured, compliance, etc.)
  // regardless of individual users' own toggles; neither side alone turns
  // a channel on.
  @Prop({ type: Object, default: { emailEnabled: true, pushEnabled: true } })
  notificationPolicy: { emailEnabled: boolean; pushEnabled: boolean };

  // Voice & Accent — the organization's part of the one central voice
  // configuration (the other part is User.voicePreferences; voice/
  // voice-config.service.ts resolve() is the only place they are combined).
  // Every field is optional: an org that never touched it has {} and speaks
  // with the system default voice. Ids are plain strings here — the voice
  // catalog owns what they mean and validates them; this schema stays free of
  // any dependency on it.
  @Prop({ type: Object, default: {} })
  voiceSettings: OrganizationVoiceSettings;
}

export interface OrganizationVoiceSettings {
  defaultVoiceId?: string;
  defaultPersonality?: string;
  // Whether members may pick their own voice. Absent = allowed; only an
  // explicit false blocks (a saved personal choice is kept, just not applied,
  // so turning this back on restores it).
  allowUserOverride?: boolean;
  updatedBy?: string;
  updatedAt?: Date;
}

export const OrganizationSchema = SchemaFactory.createForClass(Organization);
