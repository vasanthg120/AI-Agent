import { randomBytes } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { APP_FEATURES, DEFAULT_ROLE_FEATURES, isAiRoleAccount } from '../common/app-features';
import { hasTeamRole, isOwner } from '../common/team-roster';
import * as bcrypt from 'bcrypt';
import { Model, Types, isValidObjectId } from 'mongoose';
import { AgentRole, AgentRoleDocument } from '../agent-roles/schemas/agent-role.schema';
import type { JwtPayload } from '../auth/jwt-payload.interface';
import { CHAT_AGENTS } from '../chat/agents';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  PushSubscriptionEntry,
  SessionEntry,
  TwoFactorBackupCode,
  User,
  UserDocument,
  UserVoicePreferences,
} from './schemas/user.schema';

const SALT_ROUNDS = 12;
// A person has a handful of devices/browsers, not an unbounded stream —
// these are bounded, LRU-evicted arrays, not growing logs (see SessionEntry/
// PushSubscriptionEntry's own comments in user.schema.ts).
const MAX_SESSIONS = 10;
const MAX_PUSH_SUBSCRIPTIONS = 20;

// Roles whose dashboards are scoped to one store (see update-user.dto.ts).
const STORE_SCOPED_ROLES = new Set(['manager', 'consultant']);

const LINKED_MEMBER_MESSAGE = 'This person has access through the Main Account, so it can only be changed from there.';

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

  /** The login account with this address. Member records carry the same address
   * but can't sign in, so nothing that starts from an email ever finds one. */
  findByEmail(email: string) {
    return this.userModel.findOne({ email: email.toLowerCase(), isLogin: { $ne: false } }).exec();
  }

  findById(id: string) {
    return this.userModel.findById(id).exec();
  }

  /** Whether anyone at all holds this address, login or member record. */
  async emailInUse(email: string): Promise<boolean> {
    return !!(await this.userModel.exists({ email: email.toLowerCase() }));
  }

  /**
   * Who a token really represents, or null if it must be refused — the one check
   * shared by JwtStrategy and both socket gateways. A token for a member record
   * is valid only while that record is active, still linked to the login named in
   * the token, and that login is active with this session still open. So removing
   * someone's access, deactivating them or revoking the session all take effect on
   * the very next request, whatever the token itself says.
   */
  async resolveSession(payload: Pick<JwtPayload, 'sub' | 'jti' | 'loginUserId'>): Promise<{ user: UserDocument; login: UserDocument } | null> {
    if (!payload.jti || !isValidObjectId(payload.sub)) return null;
    const user = await this.findById(payload.sub);
    if (!user || user.active === false) return null;
    let login = user;
    if (payload.loginUserId || user.linkedLoginUserId) {
      if (!payload.loginUserId || user.linkedLoginUserId !== payload.loginUserId) return null;
      const linked = await this.findById(payload.loginUserId);
      if (!linked || linked.active === false) return null;
      login = linked;
    }
    if (!(login.sessions ?? []).some((s) => s.jti === payload.jti)) return null;
    return { user, login };
  }

  // ---- member records: one per extra business a person may enter --------------

  findLinkedMember(loginUserId: string, organizationId: string) {
    return this.userModel.findOne({ linkedLoginUserId: loginUserId, organizationId }).exec();
  }

  findLinkedMembersOfLogin(loginUserId: string) {
    return this.userModel.find({ linkedLoginUserId: loginUserId }).exec();
  }

  /** Gives a login access to another business. Safe to repeat: an existing record
   * just takes the new role and becomes active again. */
  createLinkedMember(login: UserDocument, organizationId: string, role: string, storeId?: string) {
    return this.userModel
      .findOneAndUpdate(
        { linkedLoginUserId: login._id.toString(), organizationId },
        {
          $set: { roles: [role], active: true, ...(storeId ? { storeId } : {}) },
          $setOnInsert: { email: login.email, name: login.name, isLogin: false, emailVerified: true },
        },
        { upsert: true, new: true },
      )
      .exec();
  }

  async removeLinkedMember(loginUserId: string, organizationId: string): Promise<boolean> {
    const result = await this.userModel.deleteOne({ linkedLoginUserId: loginUserId, organizationId }).exec();
    return result.deletedCount > 0;
  }

  // ---- invitations (see InvitationsService) -------------------------------------

  setInvitation(userId: string, inviteTokenHash: string, inviteExpiresAt: Date) {
    return this.userModel.updateOne({ _id: userId }, { $set: { inviteTokenHash, inviteExpiresAt } }).exec();
  }

  findByInvitation(inviteTokenHash: string) {
    return this.userModel.findOne({ inviteTokenHash, inviteExpiresAt: { $gt: new Date() }, isLogin: { $ne: false }, active: { $ne: false } }).exec();
  }

  /** One atomic update, so the same link can never set a password twice. */
  consumeInvitation(inviteTokenHash: string, passwordHash: string) {
    return this.userModel
      .findOneAndUpdate(
        { inviteTokenHash, inviteExpiresAt: { $gt: new Date() }, isLogin: { $ne: false }, active: { $ne: false } },
        { $set: { passwordHash, emailVerified: true }, $unset: { inviteTokenHash: '', inviteExpiresAt: '' } },
        { new: true },
      )
      .exec();
  }

  async organizationName(organizationId: string): Promise<string> {
    if (!isValidObjectId(organizationId)) return '';
    const org = await this.userModel.db.collection('organizations').findOne({ _id: new Types.ObjectId(organizationId) }, { projection: { name: 1 } });
    return typeof org?.name === 'string' ? org.name : '';
  }

  /** Cron/report fan-out, scoped to one store within one org — replaces the
   * old system-wide findAllIds(). storeId omitted (or undefined on the user)
   * matches "belongs to the org generally" so an org owner without a
   * specific store assignment still gets the default store's reports. */
  async findIdsByOrgAndStore(organizationId: string, storeId: string): Promise<string[]> {
    const users = await this.userModel
      .find({ organizationId, linkedLoginUserId: { $exists: false }, $or: [{ storeId: { $exists: false } }, { storeId }] })
      .select({ _id: 1 })
      .exec();
    return users.map((u) => u._id.toString());
  }

  /** The business's own people. Someone who has entered from their Main Account
   * isn't one of its employees, so they stay out of every team list, picker and
   * report that starts here; findAllWithLinkedMembers is the Users page's view. */
  async findAll(organizationId: string): Promise<UserDocument[]> {
    return this.userModel.find({ organizationId, linkedLoginUserId: { $exists: false } }).exec();
  }

  async findAllWithLinkedMembers(organizationId: string): Promise<UserDocument[]> {
    return this.userModel.find({ organizationId }).exec();
  }

  /**
   * The people the team dashboards report on (see common/team-roster.ts):
   * active accounts with a sales account type, plus anyone active who has a
   * connected mailbox or deals assigned to them — never the owner.
   */
  async findTeamRoster(organizationId: string): Promise<UserDocument[]> {
    // Never the owner: they run the workspace and are not one of its employees.
    const users = (await this.findAll(organizationId)).filter((u) => u.active !== false && !isOwner(u.roles));
    const ids = users.map((u) => u._id.toString());
    if (ids.length === 0) return [];
    const db = this.userModel.db;
    const [mailboxOwners, dealOwners] = await Promise.all([
      db.collection('outlook_connections').distinct('userId', { userId: { $in: ids }, isActive: true }),
      db.collection('crm_deals').distinct('ownerId', { organizationId, ownerId: { $in: ids } }),
    ]);
    const working = new Set<string>([...mailboxOwners, ...dealOwners].map(String));
    return users.filter((u) => hasTeamRole(u.roles) || working.has(u._id.toString()));
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

  /** A role's own requirements, checked against this organization's data:
   * an Agent User must be locked to one of the organization's active agents,
   * and a Manager/Consultant must belong to one of the organization's own
   * stores (never another organization's, even with a valid id). */
  private async assertRoleRequirements(organizationId: string, role: string, assignedAgentId?: string, storeId?: string): Promise<void> {
    if (role === 'agent_user') {
      if (!assignedAgentId) throw new BadRequestException('Choose which AI agent this Agent User is locked to.');
      if (!(await this.resolveValidAgentIds(organizationId)).has(assignedAgentId)) {
        throw new BadRequestException('That AI agent no longer exists or isn’t active. Pick another one.');
      }
    }
    if (STORE_SCOPED_ROLES.has(role)) {
      if (!storeId) throw new BadRequestException('Choose the store this Manager/Consultant belongs to.');
      const store = isValidObjectId(storeId)
        ? await this.userModel.db.collection('stores').findOne({ _id: new Types.ObjectId(storeId), organizationId }, { projection: { _id: 1 } })
        : null;
      if (!store) throw new BadRequestException('That store doesn’t belong to your organization. Pick one from the list.');
    }
  }

  /**
   * The app features an account gets from its AI role — undefined for accounts
   * that aren't tied to one (their fixed role decides instead). An AI role that
   * has been deleted or switched back to draft gives nothing beyond the basics.
   */
  async resolveFeatures(user: { roles: string[]; organizationId: string; assignedAgentId?: string }): Promise<string[] | undefined> {
    if (!isAiRoleAccount(user.roles)) return undefined;
    if (!user.assignedAgentId) return [];
    const role = await this.userModel.db
      .collection('agent_roles')
      .findOne({ organizationId: user.organizationId, slug: user.assignedAgentId, status: 'active' }, { projection: { features: 1 } });
    if (!role) return [];
    const features = Array.isArray(role.features) ? (role.features as string[]) : DEFAULT_ROLE_FEATURES;
    return features.filter((f) => (APP_FEATURES as readonly string[]).includes(f));
  }

  /** The signed-in user's own profile, with what their AI role lets them use. */
  async profile(userId: string) {
    const user = await this.findById(userId);
    if (!user) return null;
    const features = await this.resolveFeatures(user);
    let aiRoleName: string | undefined;
    if (features !== undefined && user.assignedAgentId) {
      const role = await this.userModel.db
        .collection('agent_roles')
        .findOne({ organizationId: user.organizationId, slug: user.assignedAgentId }, { projection: { name: 1 } });
      aiRoleName = typeof role?.name === 'string' ? role.name : undefined;
    }
    return { ...this.toPublic(user), features, aiRoleName, avatarUrl: await this.avatarOf(user) };
  }

  /** A person's profile photo, whichever business they're working in. */
  private async avatarOf(user: UserDocument): Promise<string | undefined> {
    const row = await this.userModel.findById(user.linkedLoginUserId ?? user._id).select('avatar').lean().exec();
    return row?.avatar;
  }

  async createByAdmin(dto: CreateUserDto, organizationId: string) {
    const email = dto.email.trim().toLowerCase();
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Enter the person’s name.');
    await this.assertRoleRequirements(organizationId, dto.role, dto.assignedAgentId, dto.storeId);
    // Email addresses are unique across HaiVE (one account per address, whichever organization it's in).
    if (await this.userModel.exists({ email })) {
      throw new ConflictException('An account with this email address already exists.');
    }

    // With an invitation there is no temporary password at all: the account has no
    // way in until the person sets their own through the emailed link.
    const tempPassword = dto.sendInvite ? undefined : randomBytes(9).toString('base64url');
    const passwordHash = tempPassword ? await bcrypt.hash(tempPassword, SALT_ROUNDS) : undefined;
    try {
      const user = await this.userModel.create({
        email,
        passwordHash,
        name,
        organizationId,
        storeId: STORE_SCOPED_ROLES.has(dto.role) ? dto.storeId : undefined,
        roles: [dto.role],
        assignedAgentId: dto.role === 'agent_user' ? dto.assignedAgentId : undefined,
        department: dto.department?.trim() || undefined,
        active: true,
        voiceAccessEnabled: dto.voiceAccessEnabled ?? true,
        aiAccessEnabled: dto.aiAccessEnabled ?? true,
      });
      return { user: this.toPublic(user), tempPassword };
    } catch (err) {
      // Two admins creating the same address at the same moment: the unique index decides.
      if ((err as { code?: number }).code === 11000) throw new ConflictException('An account with this email address already exists.');
      throw err;
    }
  }

  async updateByAdmin(id: string, dto: UpdateUserDto, organizationId: string, callerId?: string) {
    // Scoped by organizationId, not just _id — an admin from org A must
    // never be able to modify a user in org B, even by guessing/enumerating
    // a valid Mongo _id.
    const target = isValidObjectId(id) ? await this.userModel.findOne({ _id: id, organizationId }).exec() : null;
    if (!target) throw new NotFoundException('User not found');
    if (target.linkedLoginUserId) throw new ForbiddenException(LINKED_MEMBER_MESSAGE);

    // The org owner is a single, special account with no transfer flow in
    // this codebase — no other admin may change it, and nobody (the owner
    // included) can change its role or switch it off. The owner can still
    // edit their own name, department and AI/voice settings here.
    if (target.roles.includes('owner')) {
      if (callerId !== id) throw new ForbiddenException("The organization owner's account can't be modified or deleted by another admin");
      if (dto.role !== undefined || dto.active !== undefined || dto.assignedAgentId !== undefined || dto.storeId !== undefined) {
        throw new BadRequestException("The owner's role and status can't be changed.");
      }
    }

    // The role the account will have after this change decides what it needs
    // — so changing only the role is checked against the agent/store the
    // account already has, and vice versa.
    const role = dto.role ?? target.roles[0];
    const assignedAgentId = dto.assignedAgentId ?? target.assignedAgentId;
    const storeId = dto.storeId ?? target.storeId;
    if (dto.role !== undefined || dto.assignedAgentId !== undefined || dto.storeId !== undefined) {
      await this.assertRoleRequirements(organizationId, role, assignedAgentId, storeId);
    }

    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Enter the person’s name.');
      set.name = name;
    }
    if (dto.role) set.roles = [dto.role];
    // An agent / store only means something for the roles that use it — never
    // left behind (and silently applied again later) after a role change.
    if (role === 'agent_user') set.assignedAgentId = assignedAgentId;
    else if (target.assignedAgentId) unset.assignedAgentId = '';
    if (STORE_SCOPED_ROLES.has(role)) set.storeId = storeId;
    else if (dto.role !== undefined && target.storeId && !target.roles.includes('owner')) unset.storeId = '';
    if (dto.active !== undefined) set.active = dto.active;
    if (dto.department !== undefined) set.department = dto.department.trim();
    if (dto.voiceAccessEnabled !== undefined) set.voiceAccessEnabled = dto.voiceAccessEnabled;
    if (dto.aiAccessEnabled !== undefined) set.aiAccessEnabled = dto.aiAccessEnabled;
    // Switching an account off signs it out everywhere (its sessions are also refused by JwtStrategy while inactive).
    if (dto.active === false) set.sessions = [];

    const updated = await this.userModel
      .findOneAndUpdate({ _id: id, organizationId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('User not found');
    return this.toPublic(updated);
  }

  async deleteByAdmin(id: string, organizationId: string) {
    await this.assertNotOwner(id, organizationId);
    const deleted = await this.userModel.findOneAndDelete({ _id: id, organizationId }).exec();
    if (!deleted) throw new NotFoundException('User not found');
    // Their access to any other business goes with them.
    await this.userModel.deleteMany({ linkedLoginUserId: id }).exec();
  }

  async updateOwnProfile(userId: string, dto: UpdateProfileDto) {
    const update: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Name cannot be empty');
      update.name = name;
    }
    if (dto.phone !== undefined) update['preferences.phone'] = dto.phone.trim();
    if (dto.timezone !== undefined) {
      try {
        // Throws RangeError for anything that isn't a real IANA zone.
        new Intl.DateTimeFormat('en-US', { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException('timezone must be a valid IANA time zone, e.g. Asia/Kolkata');
      }
      update['preferences.timezone'] = dto.timezone;
    }
    if (dto.language !== undefined) update['preferences.language'] = dto.language;

    const updated = await this.userModel.findByIdAndUpdate(userId, { $set: update }, { new: true }).exec();
    if (!updated) throw new NotFoundException('User not found');
    if (dto.avatar !== undefined) {
      await this.userModel.updateOne({ _id: updated.linkedLoginUserId ?? updated._id }, dto.avatar ? { $set: { avatar: dto.avatar } } : { $unset: { avatar: '' } }).exec();
    }
    return { ...this.toPublic(updated), avatarUrl: await this.avatarOf(updated) };
  }

  private async assertNotOwner(id: string, organizationId: string): Promise<void> {
    const target = await this.userModel.findOne({ _id: id, organizationId }).select({ roles: 1, linkedLoginUserId: 1 }).exec();
    if (target?.linkedLoginUserId) throw new ForbiddenException(LINKED_MEMBER_MESSAGE);
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
      aiAccessEnabled: user.aiAccessEnabled,
      // Has access through the Main Account rather than being one of this
      // business's own people; the Users page labels and protects these.
      linkedFromMain: !!user.linkedLoginUserId,
      // Invited and hasn't set a password yet.
      pendingInvitation: !user.passwordHash && !!user.inviteTokenHash,
      // Self-editable profile fields (see updateOwnProfile) live in the
      // free-form preferences object rather than as top-level schema fields.
      phone: typeof user.preferences?.phone === 'string' ? user.preferences.phone : undefined,
      timezone: typeof user.preferences?.timezone === 'string' ? user.preferences.timezone : undefined,
      language: typeof user.preferences?.language === 'string' ? user.preferences.language : undefined,
      createdAt: (user as unknown as { createdAt?: Date }).createdAt,
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

  // --- Voice & Accent preference (persistence only — the rules live in
  // voice/voice-config.service.ts) ---

  async getVoicePreferences(userId: string): Promise<UserVoicePreferences> {
    const user = await this.userModel.findById(userId).select({ voicePreferences: 1 }).lean().exec();
    return user?.voicePreferences ?? {};
  }

  /** `null` clears a field; `undefined` leaves it alone. */
  async updateVoicePreferences(
    userId: string,
    patch: { voiceId?: string | null; personality?: string | null },
  ): Promise<UserVoicePreferences> {
    const set: Record<string, string> = {};
    const unset: Record<string, ''> = {};
    for (const key of ['voiceId', 'personality'] as const) {
      const value = patch[key];
      if (value === null) unset[`voicePreferences.${key}`] = '';
      else if (value !== undefined) set[`voicePreferences.${key}`] = value;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (!Object.keys(update).length) return this.getVoicePreferences(userId);

    const user = await this.userModel.findByIdAndUpdate(userId, update, { new: true }).select({ voicePreferences: 1 }).lean().exec();
    return user?.voicePreferences ?? {};
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
