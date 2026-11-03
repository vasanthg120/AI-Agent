import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type { CloudOwnership, CloudProviderId } from '../cloud-files.types';

export type CloudConnectionDocument = CloudConnection & Document<Types.ObjectId>;

// One connected Google Drive or OneDrive account. A personal one is browsed only by
// the person who connected it; the organization's company account (one per
// provider, connected by an owner or admin) is shared by folder grants
// (cloud_folder_grants). Tokens are encrypted at rest and never leave the backend.
@Schema({ timestamps: true, collection: 'cloud_connections' })
export class CloudConnection {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  provider: CloudProviderId;

  @Prop({ required: true })
  ownership: CloudOwnership;

  /** Who connected it — for a personal account, the only person who may use it. */
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true })
  accountId: string;

  @Prop({ default: '' })
  accountEmail: string;

  @Prop()
  accountName?: string;

  /** Microsoft: the account's own tenant (the consumer tenant for a personal account). */
  @Prop()
  tenantId?: string;

  /** OneDrive: the account's own drive. */
  @Prop()
  driveId?: string;

  @Prop({ required: true })
  accessToken: string;

  @Prop()
  refreshToken?: string;

  @Prop({ required: true })
  expiresAt: Date;

  /** What the account granted, as the provider reported it. */
  @Prop({ default: '' })
  scope: string;

  /** needs_reauth: the provider refused to refresh (revoked, password changed, expired consent) — only reconnecting fixes it. */
  @Prop({ default: 'connected' })
  status: 'connected' | 'needs_reauth';

  @Prop()
  lastSyncAt?: Date;

  @Prop()
  lastSyncStatus?: 'ok' | 'error';

  @Prop()
  lastSyncError?: string;

  /** Where the next incremental sync starts (Google's start page token). */
  @Prop()
  changeCursor?: string;
}

export const CloudConnectionSchema = SchemaFactory.createForClass(CloudConnection);
// The same account connected twice by the same person is one connection (a reconnect updates it).
CloudConnectionSchema.index({ organizationId: 1, provider: 1, ownership: 1, userId: 1, accountId: 1 }, { unique: true });
// One company account per provider per organization.
CloudConnectionSchema.index(
  { organizationId: 1, provider: 1 },
  { unique: true, partialFilterExpression: { ownership: 'company' }, name: 'one_company_account_per_provider' },
);
