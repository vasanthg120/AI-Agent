import { randomBytes } from 'crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import { AgentRole, AgentRoleDocument } from '../agent-roles/schemas/agent-role.schema';
import { CHAT_AGENTS } from '../chat/agents';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PushSubscriptionEntry, SessionEntry, TwoFactorBackupCode, User, UserDocument } from './schemas/user.schema';

const SALT_ROUNDS = 12;
// A person has a handful of devices/browsers, not an unbounded stream —
// these are bounded, LRU-evicted arrays, not growing logs (see SessionEntry/
// PushSubscriptionEntry's own comments in user.schema.ts).
const MAX_SESSIONS = 10;
const MAX_PUSH_SUBSCRIPTIONS = 20;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    // Independent local registration for validation only — importing
    // ChatModule directly here would create a cycle (AuthModule imports
    // UsersModule, ChatModule imports AuthModule), same reasoning ChatModule
    // itself already uses for this collection.
    @InjectModel(AgentRole.name) private agentRoleModel: Model<AgentRoleDocument>,
  ) {}

  findByEmail(email: string) {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  findById(id: string) {
    return this.userModel.findById(id).exec();
  }

  /** Cron/report fan-out, scoped to one store within one org — replaces the
   * old system-wide findAllIds(). storeId omitted (or undefined on the user)
   * matches "belongs to the org generally" so an org owner without a
   * specific store assignment still gets the default store's reports. */
  async findIdsByOrgAndStore(organizationId: string, storeId: string): Promise<string[]> {
    const users = await this.userModel
      .find({ organizationId, $or: [{ storeId: { $exists: false } }, { storeId }] })
      .select({ _id: 1 })
      .exec();
    return users.map((u) => u._id.toString());
  }

  async findAll(organizationId: string): Promise<UserDocument[]> {
    return this.userModel.find({ organizationId }).exec();
  }

  create(data: {
    email: string;
    passwordHash?: string;
    name: string;
    organizationId: string;
    storeId?: string;
    roles?: string[];
  }) {
    return this.userModel.create(data);
  }

  findByOAuthId(provider: 'google' | 'microsoft' | 'github', providerId: string) {
    return this.userModel.findOne({ [`oauthProviders.${provider}`]: providerId }).exec();
  }

  linkOAuthProvider(userId: string, provider: 'google' | 'microsoft' | 'github', providerId: string) {
    return this.userModel
      .findByIdAndUpdate(userId, { [`oauthProviders.${provider}`]: providerId }, { new: true })
      .exec();
  }

  async createByAdmin(dto: CreateUserDto, organizationId: string) {
    if (dto.role === 'agent_user') {
      if (!dto.assignedAgentId) {
        throw new BadRequestException('assignedAgentId is required for agent_user role');
      }
      if (!(await this.resolveValidAgentIds(organizationId)).has(dto.assignedAgentId)) {
        throw new BadRequestException('assignedAgentId is not a known agent');
      }
    }

    const tempPassword = randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
    const user = await this.userModel.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
      organizationId,
      storeId: dto.storeId,
      roles: [dto.role],
      assignedAgentId: dto.role === 'agent_user' ? dto.assignedAgentId : undefined,
      department: dto.department,
      active: true,
      voiceAccessEnabled: dto.voiceAccessEnabled ?? true,
    });
    return { user: this.toPublic(user), tempPassword };
  }

  async updateByAdmin(id: string, dto: UpdateUserDto, organizationId: string) {
    if (dto.assignedAgentId && !(await this.resolveValidAgentIds(organizationId)).has(dto.assignedAgentId)) {
      throw new BadRequestException('assignedAgentId is not a known agent');
    }

    // The org owner is a single, special account with no transfer flow in
    // this codebase — without this check, any other 'admin' (a role any
    // owner can grant) could strip or disable the real owner via this same
    // route the owner uses to manage everyone else.
    await this.assertNotOwner(id, organizationId);

    const update: Record<string, unknown> = {};
    if (dto.role) update.roles = [dto.role];
    if (dto.assignedAgentId !== undefined) update.assignedAgentId = dto.assignedAgentId;
    if (dto.storeId !== undefined) update.storeId = dto.storeId;
    if (dto.active !== undefined) update.active = dto.active;
    if (dto.department !== undefined) update.department = dto.department;
    if (dto.voiceAccessEnabled !== undefined) update.voiceAccessEnabled = dto.voiceAccessEnabled;

    // Scoped by organizationId, not just _id — an admin from org A must
    // never be able to modify a user in org B, even by guessing/enumerating
    // a valid Mongo _id.
    const updated = await this.userModel.findOneAndUpdate({ _id: id, organizationId }, update, { new: true }).exec();
    if (!updated) throw new NotFoundException('User not found');
    return this.toPublic(updated);
  }

  async deleteByAdmin(id: string, organizationId: string) {
    await this.assertNotOwner(id, organizationId);
    const deleted = await this.userModel.findOneAndDelete({ _id: id, organizationId }).exec();
    if (!deleted) throw new NotFoundException('User not found');
  }

  private async assertNotOwner(id: string, organizationId: string): Promise<void> {
    const target = await this.userModel.findOne({ _id: id, organizationId }).select({ roles: 1 }).exec();
    if (target?.roles.includes('owner')) {
      throw new ForbiddenException("The organization owner's account can't be modified or deleted by another admin");
    }
  }

  toPublic(user: UserDocument) {
    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      organizationId: user.organizationId,
      storeId: user.storeId,
      roles: user.roles,
      assignedAgentId: user.assignedAgentId,
      department: user.department,
      active: user.active,
      voiceAccessEnabled: user.voiceAccessEnabled,
    };
  }

  setVerifyOtp(userId: string, otpHash: string, expiresAt: Date) {
    return this.userModel
      .findByIdAndUpdate(userId, { verifyOtpHash: otpHash, verifyOtpExpiresAt: expiresAt })
      .exec();
  }

  markEmailVerified(userId: string) {
    return this.userModel
      .findByIdAndUpdate(userId, {
        emailVerified: true,
        $unset: { verifyOtpHash: '', verifyOtpExpiresAt: '' },
      })
      .exec();
  }

  setResetOtp(userId: string, otpHash: string, expiresAt: Date) {
    return this.userModel.findByIdAndUpdate(userId, { resetOtpHash: otpHash, resetOtpExpiresAt: expiresAt }).exec();
  }

  resetPassword(userId: string, passwordHash: string) {
    return this.userModel
      .findByIdAndUpdate(userId, { passwordHash, $unset: { resetOtpHash: '', resetOtpExpiresAt: '' } })
      .exec();
  }

  // --- Sessions ---

  /** Pushes a new session, evicting the least-recently-seen entry first if
   * already at MAX_SESSIONS. */
  async addSession(userId: string, entry: SessionEntry): Promise<void> {
    const user = await this.userModel.findById(userId).select({ sessions: 1 }).exec();
    if (!user) return;
    let sessions = user.sessions ?? [];
    if (sessions.length >= MAX_SESSIONS) {
      const oldest = [...sessions].sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime())[0];
      sessions = sessions.filter((s) => s.jti !== oldest.jti);
    }
    sessions.push(entry);
    await this.userModel.updateOne({ _id: userId }, { sessions }).exec();
  }

  /** Fire-and-forget from JwtStrategy — only writes if lastSeenAt is more
   * than a minute stale, so normal API traffic doesn't turn every request
   * into a write. */
  touchSessionIfStale(userId: string, jti: string): Promise<unknown> {
    const STALE_MS = 60_000;
    return this.userModel
      .updateOne(
        { _id: userId, sessions: { $elemMatch: { jti, lastSeenAt: { $lt: new Date(Date.now() - STALE_MS) } } } },
        { $set: { 'sessions.$.lastSeenAt': new Date() } },
      )
      .exec();
  }

  revokeSession(userId: string, jti: string) {
    return this.userModel.updateOne({ _id: userId }, { $pull: { sessions: { jti } } }).exec();
  }

  /** keepJti is always the caller's own current session (password change,
   * 2FA disable, and the explicit "revoke all others" action all pass their
   * own current jti) — there's no code path that revokes every session
   * including the caller's own from this method. Returns the revoked jtis
   * (not just a count) so callers can also disconnect each one's live
   * sockets via ChatGateway.disconnectSession. */
  async revokeAllOtherSessions(userId: string, keepJti: string): Promise<string[]> {
    const user = await this.userModel.findById(userId).select({ sessions: 1 }).exec();
    if (!user) return [];
    const revokedJtis = user.sessions.filter((s) => s.jti !== keepJti).map((s) => s.jti);
    if (revokedJtis.length > 0) {
      await this.userModel
        .updateOne({ _id: userId }, { sessions: user.sessions.filter((s) => s.jti === keepJti) })
        .exec();
    }
    return revokedJtis;
  }

  // --- Web Push subscriptions ---

  /** Upsert-by-endpoint (re-subscribing the same browser replaces, never
   * duplicates), evicting the oldest entry first if already at
   * MAX_PUSH_SUBSCRIPTIONS. */
  async addOrReplacePushSubscription(userId: string, entry: PushSubscriptionEntry): Promise<void> {
    const user = await this.userModel.findById(userId).select({ pushSubscriptions: 1 }).exec();
    if (!user) return;
    let subs = (user.pushSubscriptions ?? []).filter((s) => s.endpoint !== entry.endpoint);
    if (subs.length >= MAX_PUSH_SUBSCRIPTIONS) {
      const oldest = [...subs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      subs = subs.filter((s) => s.endpoint !== oldest.endpoint);
    }
    subs.push(entry);
    await this.userModel.updateOne({ _id: userId }, { pushSubscriptions: subs }).exec();
  }

  removePushSubscription(userId: string, endpoint: string) {
    return this.userModel.updateOne({ _id: userId }, { $pull: { pushSubscriptions: { endpoint } } }).exec();
  }

  // --- Notification preferences ---

  updateNotificationPreferences(
    userId: string,
    patch: Partial<{ desktopPush: boolean; mobilePush: boolean; email: boolean }>,
  ) {
    const update: Record<string, unknown> = {};
    if (patch.desktopPush !== undefined) update['notificationPreferences.desktopPush'] = patch.desktopPush;
    if (patch.mobilePush !== undefined) update['notificationPreferences.mobilePush'] = patch.mobilePush;
    if (patch.email !== undefined) update['notificationPreferences.email'] = patch.email;
    return this.userModel.findByIdAndUpdate(userId, update, { new: true }).exec();
  }

  // --- Two-factor authentication ---

  setPendingTwoFactorSecret(userId: string, secretEncrypted: string, expiresAt: Date) {
    return this.userModel
      .findByIdAndUpdate(userId, {
        twoFactorPendingSecretEncrypted: secretEncrypted,
        twoFactorPendingSecretExpiresAt: expiresAt,
      })
      .exec();
  }

  /** Promotes the pending secret to the real one, turns 2FA on, and installs
   * a freshly generated set of backup codes — all in one atomic update, so
   * there's no window where twoFactorEnabled is true but backup codes
   * haven't been set yet (or vice versa). */
  confirmTwoFactor(userId: string, secretEncrypted: string, backupCodes: TwoFactorBackupCode[]) {
    return this.userModel
      .findByIdAndUpdate(
        userId,
        {
          twoFactorEnabled: true,
          twoFactorEnabledAt: new Date(),
          twoFactorSecretEncrypted: secretEncrypted,
          twoFactorBackupCodes: backupCodes,
          $unset: { twoFactorPendingSecretEncrypted: '', twoFactorPendingSecretExpiresAt: '' },
        },
        { new: true },
      )
      .exec();
  }

  clearTwoFactor(userId: string) {
    return this.userModel
      .findByIdAndUpdate(userId, {
        twoFactorEnabled: false,
        twoFactorBackupCodes: [],
        $unset: {
          twoFactorSecretEncrypted: '',
          twoFactorEnabledAt: '',
          twoFactorPendingSecretEncrypted: '',
          twoFactorPendingSecretExpiresAt: '',
        },
      })
      .exec();
  }

  setBackupCodes(userId: string, backupCodes: TwoFactorBackupCode[]) {
    return this.userModel.findByIdAndUpdate(userId, { twoFactorBackupCodes: backupCodes }).exec();
  }

  /** codeHash is the exact stored hash that just matched via bcrypt.compare
   * in TwoFactorService — marking by hash (not index) is safe from
   * concurrent-use races changing array order between read and write. */
  markBackupCodeUsed(userId: string, codeHash: string) {
    return this.userModel
      .updateOne(
        { _id: userId, 'twoFactorBackupCodes.codeHash': codeHash },
        { $set: { 'twoFactorBackupCodes.$.usedAt': new Date() } },
      )
      .exec();
  }

  private async resolveValidAgentIds(organizationId: string): Promise<Set<string>> {
    const dynamic = await this.agentRoleModel
      .find({ status: 'active', organizationId })
      .select({ slug: 1 })
      .exec();
    return new Set<string>([...CHAT_AGENTS.map((a) => a.id), ...dynamic.map((d) => d.slug)]);
  }
}
