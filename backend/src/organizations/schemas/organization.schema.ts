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

  // 'archived' is how a sub-account is "deleted": sign-in stops and it no longer
  // renews or syncs, but its data stays and its Main Account can restore it.
  @Prop({ enum: ['active', 'suspended', 'archived'], default: 'active' })
  status: OrganizationStatus;

  // --- Sub-accounts ---
  // The Main Account this business belongs to. Absent means this IS a Main
  // Account — every organization that predates sub-accounts reads that way
  // with no migration, and account type is always derived from this one field
  // (see accountTypeOf) so the two can never disagree. One level only: a
  // sub-account never has sub-accounts of its own.
  @Prop({ index: true })
  parentOrganizationId?: string;

  // The sub-account's own owner login. Unset on Main Accounts, where the owner
  // is simply the user holding the 'owner' role.
  @Prop()
  ownerUserId?: string;

  // Who suspended it. A Main Account may lift its own suspension of a
  // sub-account, but never one set by the HaiVE platform admin.
  @Prop({ default: false })
  suspendedByParent: boolean;

  @Prop()
  archivedAt?: Date;

  // Only sub-accounts fill these in today; the Create Sub-Account form is what
  // collects them. Kept apart from Store.timezone, which times a store's daily
  // reports — this is the business's own default.
  @Prop()
  timezone?: string;

  @Prop()
  currency?: string;

  @Prop({ type: Object, default: {} })
  profile: OrganizationProfile;

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

export type OrganizationStatus = 'active' | 'suspended' | 'archived';

export interface OrganizationProfile {
  businessEmail?: string;
  phoneCountryCode?: string;
  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  // A small image as a data URL (PNG, JPEG or WebP; see sub-accounts' logo check).
  logo?: string;
}

export type AccountType = 'main' | 'sub';

export function accountTypeOf(org: { parentOrganizationId?: string }): AccountType {
  return org.parentOrganizationId ? 'sub' : 'main';
}

/** Whether a business's status stops everyone in it from signing in or using it. */
export function isOrganizationBlocked(status: OrganizationStatus | undefined): boolean {
  return status === 'suspended' || status === 'archived';
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
