import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document<Types.ObjectId>;

// One per issued session-backed JWT (jti). Embedded on User rather than a
// separate collection — JwtStrategy.validate() already does a full findById
// on every request (see its own comment), so checking this array costs
// nothing extra; a separate collection would mean a second query per
// request just to answer "is this still valid". Capped at MAX_SESSIONS in
// UsersService.addSession — a person has a handful of devices, not
// thousands, unlike Notification/AuditLog which are correctly unbounded.
@Schema({ _id: false })
export class SessionEntry {
  @Prop({ required: true })
  jti: string;

  @Prop({ required: true })
  device: string;

  @Prop()
  userAgent?: string;

  @Prop()
  ip?: string;

  @Prop()
  location?: string;

  @Prop({ required: true })
  createdAt: Date;

  @Prop({ required: true })
  lastSeenAt: Date;
}

// One per browser/device that has opted into Web Push. deviceType is
// classified server-side from the User-Agent at subscribe time (not
// client-reported) so the Desktop/Mobile notification toggles filter real,
// independent delivery rather than secretly being OR'd together.
@Schema({ _id: false })
export class PushSubscriptionEntry {
  @Prop({ required: true })
  endpoint: string;

  @Prop({ type: Object, required: true })
  keys: { p256dh: string; auth: string };

  @Prop({ required: true, enum: ['desktop', 'mobile'] })
  deviceType: 'desktop' | 'mobile';

  @Prop()
  userAgent?: string;

  @Prop({ required: true })
  createdAt: Date;
}

// bcrypt-hashed (compared one-at-a-time against at most 10 entries already
// in memory on the fetched User doc — no indexed lookup needed, unlike
// ApiToken's SHA-256 hash which does need one). usedAt marks single-use
// rather than deleting, so "codes remaining" can be reported honestly.
@Schema({ _id: false })
export class TwoFactorBackupCode {
  @Prop({ required: true })
  codeHash: string;

  @Prop()
  usedAt?: Date;
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  // Optional now — an account created via "Sign in with Google/Microsoft/
  // GitHub" (see AuthService.loginWithOAuth) has no password at all until
  // the user explicitly sets one. Every password-path call site (login,
  // reset-password) already has to check truthiness of this before
  // bcrypt.compare, since bcrypt throws on a non-string hash.
  @Prop()
  passwordHash?: string;

  @Prop({ required: true, trim: true })
  name: string;

  // The tenant this account belongs to — every org-scoped query filters on
  // this. Set once at registration (new org + owner) or admin-creation
  // (caller's own org) and never changed via the update path.
  @Prop({ required: true, index: true })
  organizationId: string;

  // Which store within the org this user is attached to — optional because
  // an org owner oversees every store, not just one. When set, scopes
  // store-specific views (Manager/Consultant dashboards, per-store cron
  // fan-out) to just this store.
  @Prop()
  storeId?: string;

  // Additive vocabulary: 'admin'/'agent_user'/'user' are the original
  // route-gating roles (see RolesGuard, @Roles() decorators throughout) and
  // keep working unchanged. 'owner'/'manager'/'consultant' are the new
  // business-hierarchy labels from the Enterprise AI OS spec, layered on top
  // rather than replacing the original three — the org's first user gets
  // ['owner', 'admin'] so every existing admin-gated route keeps working for
  // them without touching every @Roles('admin') call site.
  @Prop({ type: [String], default: ['user'] })
  roles: string[];

  // agent_id/slug (CHAT_AGENTS or AgentRole.slug); only meaningful when
  // roles includes 'agent_user' — see users.service.ts's createByAdmin.
  @Prop()
  assignedAgentId?: string;

  // Free-text label, same convention as AgentRole.department (Phase 6) —
  // matched against a custom AgentRole's assignedDepartments to decide chat
  // @mention visibility. Optional; unset means "no department filter can
  // ever match" for this user, not "sees everything" (that's governed by
  // role, see chat.service.ts's listAgents).
  @Prop()
  department?: string;

  @Prop({ default: true })
  active: boolean;

  // Provider/model-availability control, NOT an AI on/off switch — chat
  // (Anthropic) stays automatically available to every authenticated user
  // regardless of this field; it only gates the separate voice (Sarvam
  // STT/TTS) feature (see voice.controller.ts). Mongoose applies this
  // default at hydration time for any document that predates this field, so
  // every existing user reads back as enabled with no migration needed.
  @Prop({ default: true })
  voiceAccessEnabled: boolean;

  @Prop({ type: Object, default: {} })
  preferences: Record<string, unknown>;

  // Informational only today — nothing currently gates login or feature
  // access on this being true. Set once the user completes the OTP flow
  // sent at registration (see AuthService.register/verifyEmail).
  @Prop({ default: false })
  emailVerified: boolean;

  // bcrypt hash of the current outstanding OTP, never the raw code —
  // same reasoning as passwordHash. Cleared (undefined) once consumed or
  // superseded by a newer code. verify* is for the register-time
  // email-verification flow; reset* is the separate forgot-password flow —
  // kept as distinct pairs so verifying your email can never be used to
  // reset your password or vice versa.
  @Prop()
  verifyOtpHash?: string;

  @Prop()
  verifyOtpExpiresAt?: Date;

  @Prop()
  resetOtpHash?: string;

  @Prop()
  resetOtpExpiresAt?: Date;

  // Stable per-provider subject id (Google `sub`, Microsoft Graph `id`,
  // GitHub numeric `id` as a string) — looked up first on OAuth login, ahead
  // of matching by email, since a provider account's email can change while
  // its id never does. A user can accumulate more than one linked provider
  // (e.g. registered with a password, later added "Sign in with Google").
  @Prop({ type: Object, default: {} })
  oauthProviders: { google?: string; microsoft?: string; github?: string };

  // --- Two-factor authentication ---
  @Prop({ default: false })
  twoFactorEnabled: boolean;

  // AES-256-GCM via EncryptionService (see auth/two-factor.service.ts) —
  // same at-rest treatment as Outlook/Gmail OAuth refresh tokens, never the
  // raw TOTP secret.
  @Prop()
  twoFactorSecretEncrypted?: string;

  @Prop()
  twoFactorEnabledAt?: Date;

  // Set by POST /auth/2fa/setup, consumed/cleared by POST /auth/2fa/enable —
  // same "pending, TTL'd, promoted on confirmation" shape as the
  // verify/reset OTP pairs above, not yet the real secret until enabled.
  @Prop()
  twoFactorPendingSecretEncrypted?: string;

  @Prop()
  twoFactorPendingSecretExpiresAt?: Date;

  @Prop({ type: [TwoFactorBackupCode], default: [] })
  twoFactorBackupCodes: TwoFactorBackupCode[];

  // --- Sessions (session-backed JWTs; see SessionEntry's own comment) ---
  @Prop({ type: [SessionEntry], default: [] })
  sessions: SessionEntry[];

  // --- Web Push subscriptions ---
  @Prop({ type: [PushSubscriptionEntry], default: [] })
  pushSubscriptions: PushSubscriptionEntry[];

  // --- Notification channel preferences ---
  // Flat object like oauthProviders above (fixed 3 keys), not a subdocument
  // array — there's exactly one of these per user, not a growing list.
  // Effective delivery = this AND the org's own notificationPolicy ceiling
  // (see organizations/schemas/organization.schema.ts) — either can turn a
  // channel off, neither alone turns it on.
  @Prop({
    type: Object,
    default: { desktopPush: true, mobilePush: true, email: true },
  })
  notificationPreferences: { desktopPush: boolean; mobilePush: boolean; email: boolean };
}

export const UserSchema = SchemaFactory.createForClass(User);
