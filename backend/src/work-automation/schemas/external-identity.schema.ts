import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ExternalIdentityDocument = ExternalIdentity & Document<Types.ObjectId>;

export const IDENTITY_STATUSES = ['linked', 'unresolved', 'ignored'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];
// How a link was made. Never by display name: only a verified email equality
// with an active person of the same business, or an explicit admin decision.
export type IdentityMatchMethod = 'email' | 'admin';

// One external-platform person (a CRM salesperson, a mailbox owner, ...) and the
// HaiVE employee they are, per organization. A platform's own user id can differ
// from every other platform's, so each (platform, externalUserId) is its own row.
@Schema({ timestamps: true, collection: 'work_external_identities' })
export class ExternalIdentity {
  @Prop({ required: true, index: true }) organizationId: string;
  @Prop({ required: true, lowercase: true, trim: true }) platform: string;
  // The platform's own user id; when a platform only gives an email, the
  // lowercased email is the key.
  @Prop({ required: true, trim: true }) externalUserId: string;
  @Prop({ lowercase: true, trim: true }) externalEmail?: string;
  // Display only — shown to the admin resolving it, never used to match.
  @Prop() externalName?: string;

  @Prop({ enum: IDENTITY_STATUSES, default: 'unresolved', index: true }) status: IdentityStatus;
  @Prop({ index: true }) userId?: string;
  @Prop({ enum: ['email', 'admin'] }) matchMethod?: IdentityMatchMethod;
  @Prop() resolvedBy?: string;
  @Prop() resolvedAt?: Date;

  @Prop() firstSeenAt?: Date;
  @Prop() lastSeenAt?: Date;
  @Prop({ default: 0 }) seenCount: number;

  createdAt: Date;
  updatedAt: Date;
}

export const ExternalIdentitySchema = SchemaFactory.createForClass(ExternalIdentity);
ExternalIdentitySchema.index({ organizationId: 1, platform: 1, externalUserId: 1 }, { unique: true });
