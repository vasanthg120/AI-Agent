import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OutlookConnectionDocument = OutlookConnection & Document<Types.ObjectId>;

@Schema({ timestamps: true, collection: 'outlook_connections' })
export class OutlookConnection {
  @Prop({ required: true, index: true })
  userId: string;

  // Optional — absent on every connection made before org-level account
  // visibility existed. Backfilled going forward at connect time
  // (OutlookService.handleCallback); existing rows keep working unchanged
  // for every userId-scoped query (getStatus/listAccounts/setActive/
  // disconnect), which never filter on this field.
  @Prop({ index: true })
  organizationId?: string;

  @Prop({ required: true })
  email: string;

  // Every address this mailbox receives and sends as (primary, sign-in name,
  // aliases), lower-cased — learned from Outlook on each sync. A mailbox often
  // sends from an alias, so "is this from us?" is decided against all of them.
  @Prop({ type: [String], default: undefined })
  addresses?: string[];

  // The customer's own Azure AD tenant and the connecting user's own
  // Microsoft object id — decoded from the access token's `tid`/`oid`
  // claims (standard Graph v2.0 access-token claims, present without
  // requesting any extra scope). What makes a connection attributable to
  // a specific customer tenant rather than just "an email + a token" —
  // needed now that connect-url/callback accept any org via /organizations/.
  @Prop()
  microsoftTenantId?: string;

  @Prop()
  microsoftUserId?: string;

  // The team member who actually works this mailbox, when that isn't the
  // person who connected it — a shared enquiries@ / sales@ mailbox connected
  // by the owner and answered by a salesperson. The team dashboards count the
  // mailbox's email as this person's work. Unset: it counts as the connecting
  // user's own.
  @Prop()
  handledByUserId?: string;

  @Prop({ required: true })
  accessToken: string;

  @Prop({ required: true })
  refreshToken: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: '' })
  scope: string;

  // The account python-agent uses when it needs to act as "the user's
  // mailbox" — a user can have several connected accounts, but exactly one
  // is active at a time. See OutlookService.setActive.
  @Prop({ default: false })
  isActive: boolean;

  // Set to 'needs_reauth' by python-agent (see outlook_store.py's _refresh)
  // the moment a refresh attempt comes back invalid_grant — the user
  // revoked access or changed their Microsoft password, and no amount of
  // retrying fixes it without them reconnecting through the consent screen
  // again. Absent/'connected' on every row written before this existed;
  // isActive is untouched either way, so which mailbox is "the active one"
  // keeps meaning what it always did.
  @Prop({ default: 'connected' })
  status?: 'connected' | 'needs_reauth';
}

export const OutlookConnectionSchema = SchemaFactory.createForClass(OutlookConnection);
OutlookConnectionSchema.index({ userId: 1, email: 1 }, { unique: true });