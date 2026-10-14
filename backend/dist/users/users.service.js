"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsersService = void 0;
const crypto_1 = require("crypto");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const app_features_1 = require("../common/app-features");
const team_roster_1 = require("../common/team-roster");
const bcrypt = __importStar(require("bcrypt"));
const mongoose_2 = require("mongoose");
const agent_role_schema_1 = require("../agent-roles/schemas/agent-role.schema");
const agents_1 = require("../chat/agents");
const user_schema_1 = require("./schemas/user.schema");
const SALT_ROUNDS = 12;
const MAX_SESSIONS = 10;
const MAX_PUSH_SUBSCRIPTIONS = 20;
const STORE_SCOPED_ROLES = new Set(['manager', 'consultant']);
let UsersService = class UsersService {
    constructor(userModel, agentRoleModel) {
        this.userModel = userModel;
        this.agentRoleModel = agentRoleModel;
    }
    findByEmail(email) {
        return this.userModel.findOne({ email: email.toLowerCase() }).exec();
    }
    findById(id) {
        return this.userModel.findById(id).exec();
    }
    async findIdsByOrgAndStore(organizationId, storeId) {
        const users = await this.userModel
            .find({ organizationId, $or: [{ storeId: { $exists: false } }, { storeId }] })
            .select({ _id: 1 })
            .exec();
        return users.map((u) => u._id.toString());
    }
    async findAll(organizationId) {
        return this.userModel.find({ organizationId }).exec();
    }
    async findTeamRoster(organizationId) {
        const users = (await this.findAll(organizationId)).filter((u) => u.active !== false && !(0, team_roster_1.isOwner)(u.roles));
        const ids = users.map((u) => u._id.toString());
        if (ids.length === 0)
            return [];
        const db = this.userModel.db;
        const [mailboxOwners, dealOwners] = await Promise.all([
            db.collection('outlook_connections').distinct('userId', { userId: { $in: ids }, isActive: true }),
            db.collection('crm_deals').distinct('ownerId', { organizationId, ownerId: { $in: ids } }),
        ]);
        const working = new Set([...mailboxOwners, ...dealOwners].map(String));
        return users.filter((u) => (0, team_roster_1.hasTeamRole)(u.roles) || working.has(u._id.toString()));
    }
    create(data) {
        return this.userModel.create(data);
    }
    findByOAuthId(provider, providerId) {
        return this.userModel.findOne({ [`oauthProviders.${provider}`]: providerId }).exec();
    }
    linkOAuthProvider(userId, provider, providerId) {
        return this.userModel
            .findByIdAndUpdate(userId, { [`oauthProviders.${provider}`]: providerId }, { new: true })
            .exec();
    }
    async assertRoleRequirements(organizationId, role, assignedAgentId, storeId) {
        if (role === 'agent_user') {
            if (!assignedAgentId)
                throw new common_1.BadRequestException('Choose which AI agent this Agent User is locked to.');
            if (!(await this.resolveValidAgentIds(organizationId)).has(assignedAgentId)) {
                throw new common_1.BadRequestException('That AI agent no longer exists or isn’t active. Pick another one.');
            }
        }
        if (STORE_SCOPED_ROLES.has(role)) {
            if (!storeId)
                throw new common_1.BadRequestException('Choose the store this Manager/Consultant belongs to.');
            const store = (0, mongoose_2.isValidObjectId)(storeId)
                ? await this.userModel.db.collection('stores').findOne({ _id: new mongoose_2.Types.ObjectId(storeId), organizationId }, { projection: { _id: 1 } })
                : null;
            if (!store)
                throw new common_1.BadRequestException('That store doesn’t belong to your organization. Pick one from the list.');
        }
    }
    async resolveFeatures(user) {
        if (!(0, app_features_1.isAiRoleAccount)(user.roles))
            return undefined;
        if (!user.assignedAgentId)
            return [];
        const role = await this.userModel.db
            .collection('agent_roles')
            .findOne({ organizationId: user.organizationId, slug: user.assignedAgentId, status: 'active' }, { projection: { features: 1 } });
        if (!role)
            return [];
        const features = Array.isArray(role.features) ? role.features : app_features_1.DEFAULT_ROLE_FEATURES;
        return features.filter((f) => app_features_1.APP_FEATURES.includes(f));
    }
    async profile(userId) {
        const user = await this.findById(userId);
        if (!user)
            return null;
        const features = await this.resolveFeatures(user);
        let aiRoleName;
        if (features !== undefined && user.assignedAgentId) {
            const role = await this.userModel.db
                .collection('agent_roles')
                .findOne({ organizationId: user.organizationId, slug: user.assignedAgentId }, { projection: { name: 1 } });
            aiRoleName = typeof role?.name === 'string' ? role.name : undefined;
        }
        return { ...this.toPublic(user), features, aiRoleName };
    }
    async createByAdmin(dto, organizationId) {
        const email = dto.email.trim().toLowerCase();
        const name = dto.name.trim();
        if (!name)
            throw new common_1.BadRequestException('Enter the person’s name.');
        await this.assertRoleRequirements(organizationId, dto.role, dto.assignedAgentId, dto.storeId);
        if (await this.userModel.exists({ email })) {
            throw new common_1.ConflictException('An account with this email address already exists.');
        }
        const tempPassword = (0, crypto_1.randomBytes)(9).toString('base64url');
        const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
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
        }
        catch (err) {
            if (err.code === 11000)
                throw new common_1.ConflictException('An account with this email address already exists.');
            throw err;
        }
    }
    async updateByAdmin(id, dto, organizationId, callerId) {
        const target = (0, mongoose_2.isValidObjectId)(id) ? await this.userModel.findOne({ _id: id, organizationId }).exec() : null;
        if (!target)
            throw new common_1.NotFoundException('User not found');
        if (target.roles.includes('owner')) {
            if (callerId !== id)
                throw new common_1.ForbiddenException("The organization owner's account can't be modified or deleted by another admin");
            if (dto.role !== undefined || dto.active !== undefined || dto.assignedAgentId !== undefined || dto.storeId !== undefined) {
                throw new common_1.BadRequestException("The owner's role and status can't be changed.");
            }
        }
        const role = dto.role ?? target.roles[0];
        const assignedAgentId = dto.assignedAgentId ?? target.assignedAgentId;
        const storeId = dto.storeId ?? target.storeId;
        if (dto.role !== undefined || dto.assignedAgentId !== undefined || dto.storeId !== undefined) {
            await this.assertRoleRequirements(organizationId, role, assignedAgentId, storeId);
        }
        const set = {};
        const unset = {};
        if (dto.name !== undefined) {
            const name = dto.name.trim();
            if (!name)
                throw new common_1.BadRequestException('Enter the person’s name.');
            set.name = name;
        }
        if (dto.role)
            set.roles = [dto.role];
        if (role === 'agent_user')
            set.assignedAgentId = assignedAgentId;
        else if (target.assignedAgentId)
            unset.assignedAgentId = '';
        if (STORE_SCOPED_ROLES.has(role))
            set.storeId = storeId;
        else if (dto.role !== undefined && target.storeId && !target.roles.includes('owner'))
            unset.storeId = '';
        if (dto.active !== undefined)
            set.active = dto.active;
        if (dto.department !== undefined)
            set.department = dto.department.trim();
        if (dto.voiceAccessEnabled !== undefined)
            set.voiceAccessEnabled = dto.voiceAccessEnabled;
        if (dto.aiAccessEnabled !== undefined)
            set.aiAccessEnabled = dto.aiAccessEnabled;
        if (dto.active === false)
            set.sessions = [];
        const updated = await this.userModel
            .findOneAndUpdate({ _id: id, organizationId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true })
            .exec();
        if (!updated)
            throw new common_1.NotFoundException('User not found');
        return this.toPublic(updated);
    }
    async deleteByAdmin(id, organizationId) {
        await this.assertNotOwner(id, organizationId);
        const deleted = await this.userModel.findOneAndDelete({ _id: id, organizationId }).exec();
        if (!deleted)
            throw new common_1.NotFoundException('User not found');
    }
    async updateOwnProfile(userId, dto) {
        const update = {};
        if (dto.name !== undefined) {
            const name = dto.name.trim();
            if (!name)
                throw new common_1.BadRequestException('Name cannot be empty');
            update.name = name;
        }
        if (dto.phone !== undefined)
            update['preferences.phone'] = dto.phone.trim();
        if (dto.timezone !== undefined) {
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: dto.timezone });
            }
            catch {
                throw new common_1.BadRequestException('timezone must be a valid IANA time zone, e.g. Asia/Kolkata');
            }
            update['preferences.timezone'] = dto.timezone;
        }
        if (dto.language !== undefined)
            update['preferences.language'] = dto.language;
        const updated = await this.userModel.findByIdAndUpdate(userId, { $set: update }, { new: true }).exec();
        if (!updated)
            throw new common_1.NotFoundException('User not found');
        return this.toPublic(updated);
    }
    async assertNotOwner(id, organizationId) {
        const target = await this.userModel.findOne({ _id: id, organizationId }).select({ roles: 1 }).exec();
        if (target?.roles.includes('owner')) {
            throw new common_1.ForbiddenException("The organization owner's account can't be modified or deleted by another admin");
        }
    }
    toPublic(user) {
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
            phone: typeof user.preferences?.phone === 'string' ? user.preferences.phone : undefined,
            timezone: typeof user.preferences?.timezone === 'string' ? user.preferences.timezone : undefined,
            language: typeof user.preferences?.language === 'string' ? user.preferences.language : undefined,
            createdAt: user.createdAt,
        };
    }
    setVerifyOtp(userId, otpHash, expiresAt) {
        return this.userModel
            .findByIdAndUpdate(userId, { verifyOtpHash: otpHash, verifyOtpExpiresAt: expiresAt })
            .exec();
    }
    markEmailVerified(userId) {
        return this.userModel
            .findByIdAndUpdate(userId, {
            emailVerified: true,
            $unset: { verifyOtpHash: '', verifyOtpExpiresAt: '' },
        })
            .exec();
    }
    setResetOtp(userId, otpHash, expiresAt) {
        return this.userModel.findByIdAndUpdate(userId, { resetOtpHash: otpHash, resetOtpExpiresAt: expiresAt }).exec();
    }
    resetPassword(userId, passwordHash) {
        return this.userModel
            .findByIdAndUpdate(userId, { passwordHash, $unset: { resetOtpHash: '', resetOtpExpiresAt: '' } })
            .exec();
    }
    async addSession(userId, entry) {
        const user = await this.userModel.findById(userId).select({ sessions: 1 }).exec();
        if (!user)
            return;
        let sessions = user.sessions ?? [];
        if (sessions.length >= MAX_SESSIONS) {
            const oldest = [...sessions].sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime())[0];
            sessions = sessions.filter((s) => s.jti !== oldest.jti);
        }
        sessions.push(entry);
        await this.userModel.updateOne({ _id: userId }, { sessions }).exec();
    }
    touchSessionIfStale(userId, jti) {
        const STALE_MS = 60_000;
        return this.userModel
            .updateOne({ _id: userId, sessions: { $elemMatch: { jti, lastSeenAt: { $lt: new Date(Date.now() - STALE_MS) } } } }, { $set: { 'sessions.$.lastSeenAt': new Date() } })
            .exec();
    }
    revokeSession(userId, jti) {
        return this.userModel.updateOne({ _id: userId }, { $pull: { sessions: { jti } } }).exec();
    }
    async revokeAllOtherSessions(userId, keepJti) {
        const user = await this.userModel.findById(userId).select({ sessions: 1 }).exec();
        if (!user)
            return [];
        const revokedJtis = user.sessions.filter((s) => s.jti !== keepJti).map((s) => s.jti);
        if (revokedJtis.length > 0) {
            await this.userModel
                .updateOne({ _id: userId }, { sessions: user.sessions.filter((s) => s.jti === keepJti) })
                .exec();
        }
        return revokedJtis;
    }
    async addOrReplacePushSubscription(userId, entry) {
        const user = await this.userModel.findById(userId).select({ pushSubscriptions: 1 }).exec();
        if (!user)
            return;
        let subs = (user.pushSubscriptions ?? []).filter((s) => s.endpoint !== entry.endpoint);
        if (subs.length >= MAX_PUSH_SUBSCRIPTIONS) {
            const oldest = [...subs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
            subs = subs.filter((s) => s.endpoint !== oldest.endpoint);
        }
        subs.push(entry);
        await this.userModel.updateOne({ _id: userId }, { pushSubscriptions: subs }).exec();
    }
    removePushSubscription(userId, endpoint) {
        return this.userModel.updateOne({ _id: userId }, { $pull: { pushSubscriptions: { endpoint } } }).exec();
    }
    updateNotificationPreferences(userId, patch) {
        const update = {};
        if (patch.desktopPush !== undefined)
            update['notificationPreferences.desktopPush'] = patch.desktopPush;
        if (patch.mobilePush !== undefined)
            update['notificationPreferences.mobilePush'] = patch.mobilePush;
        if (patch.email !== undefined)
            update['notificationPreferences.email'] = patch.email;
        return this.userModel.findByIdAndUpdate(userId, update, { new: true }).exec();
    }
    async getVoicePreferences(userId) {
        const user = await this.userModel.findById(userId).select({ voicePreferences: 1 }).lean().exec();
        return user?.voicePreferences ?? {};
    }
    async updateVoicePreferences(userId, patch) {
        const set = {};
        const unset = {};
        for (const key of ['voiceId', 'personality']) {
            const value = patch[key];
            if (value === null)
                unset[`voicePreferences.${key}`] = '';
            else if (value !== undefined)
                set[`voicePreferences.${key}`] = value;
        }
        const update = {};
        if (Object.keys(set).length)
            update.$set = set;
        if (Object.keys(unset).length)
            update.$unset = unset;
        if (!Object.keys(update).length)
            return this.getVoicePreferences(userId);
        const user = await this.userModel.findByIdAndUpdate(userId, update, { new: true }).select({ voicePreferences: 1 }).lean().exec();
        return user?.voicePreferences ?? {};
    }
    setPendingTwoFactorSecret(userId, secretEncrypted, expiresAt) {
        return this.userModel
            .findByIdAndUpdate(userId, {
            twoFactorPendingSecretEncrypted: secretEncrypted,
            twoFactorPendingSecretExpiresAt: expiresAt,
        })
            .exec();
    }
    confirmTwoFactor(userId, secretEncrypted, backupCodes) {
        return this.userModel
            .findByIdAndUpdate(userId, {
            twoFactorEnabled: true,
            twoFactorEnabledAt: new Date(),
            twoFactorSecretEncrypted: secretEncrypted,
            twoFactorBackupCodes: backupCodes,
            $unset: { twoFactorPendingSecretEncrypted: '', twoFactorPendingSecretExpiresAt: '' },
        }, { new: true })
            .exec();
    }
    clearTwoFactor(userId) {
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
    setBackupCodes(userId, backupCodes) {
        return this.userModel.findByIdAndUpdate(userId, { twoFactorBackupCodes: backupCodes }).exec();
    }
    markBackupCodeUsed(userId, codeHash) {
        return this.userModel
            .updateOne({ _id: userId, 'twoFactorBackupCodes.codeHash': codeHash }, { $set: { 'twoFactorBackupCodes.$.usedAt': new Date() } })
            .exec();
    }
    async resolveValidAgentIds(organizationId) {
        const dynamic = await this.agentRoleModel
            .find({ status: 'active', organizationId })
            .select({ slug: 1 })
            .exec();
        return new Set([...agents_1.CHAT_AGENTS.map((a) => a.id), ...dynamic.map((d) => d.slug)]);
    }
};
exports.UsersService = UsersService;
exports.UsersService = UsersService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(user_schema_1.User.name)),
    __param(1, (0, mongoose_1.InjectModel)(agent_role_schema_1.AgentRole.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        mongoose_2.Model])
], UsersService);
//# sourceMappingURL=users.service.js.map