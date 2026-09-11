"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserSchema = exports.User = exports.TwoFactorBackupCode = exports.PushSubscriptionEntry = exports.SessionEntry = void 0;
const mongoose_1 = require("@nestjs/mongoose");
let SessionEntry = class SessionEntry {
};
exports.SessionEntry = SessionEntry;
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], SessionEntry.prototype, "jti", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], SessionEntry.prototype, "device", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], SessionEntry.prototype, "userAgent", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], SessionEntry.prototype, "ip", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], SessionEntry.prototype, "location", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", Date)
], SessionEntry.prototype, "createdAt", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", Date)
], SessionEntry.prototype, "lastSeenAt", void 0);
exports.SessionEntry = SessionEntry = __decorate([
    (0, mongoose_1.Schema)({ _id: false })
], SessionEntry);
let PushSubscriptionEntry = class PushSubscriptionEntry {
};
exports.PushSubscriptionEntry = PushSubscriptionEntry;
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], PushSubscriptionEntry.prototype, "endpoint", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: Object, required: true }),
    __metadata("design:type", Object)
], PushSubscriptionEntry.prototype, "keys", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, enum: ['desktop', 'mobile'] }),
    __metadata("design:type", String)
], PushSubscriptionEntry.prototype, "deviceType", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], PushSubscriptionEntry.prototype, "userAgent", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", Date)
], PushSubscriptionEntry.prototype, "createdAt", void 0);
exports.PushSubscriptionEntry = PushSubscriptionEntry = __decorate([
    (0, mongoose_1.Schema)({ _id: false })
], PushSubscriptionEntry);
let TwoFactorBackupCode = class TwoFactorBackupCode {
};
exports.TwoFactorBackupCode = TwoFactorBackupCode;
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], TwoFactorBackupCode.prototype, "codeHash", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", Date)
], TwoFactorBackupCode.prototype, "usedAt", void 0);
exports.TwoFactorBackupCode = TwoFactorBackupCode = __decorate([
    (0, mongoose_1.Schema)({ _id: false })
], TwoFactorBackupCode);
let User = class User {
};
exports.User = User;
__decorate([
    (0, mongoose_1.Prop)({ required: true, unique: true, lowercase: true, trim: true }),
    __metadata("design:type", String)
], User.prototype, "email", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "passwordHash", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, trim: true }),
    __metadata("design:type", String)
], User.prototype, "name", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, index: true }),
    __metadata("design:type", String)
], User.prototype, "organizationId", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "storeId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [String], default: ['user'] }),
    __metadata("design:type", Array)
], User.prototype, "roles", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "assignedAgentId", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "department", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: true }),
    __metadata("design:type", Boolean)
], User.prototype, "active", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: true }),
    __metadata("design:type", Boolean)
], User.prototype, "voiceAccessEnabled", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: Object, default: {} }),
    __metadata("design:type", Object)
], User.prototype, "preferences", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: false }),
    __metadata("design:type", Boolean)
], User.prototype, "emailVerified", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "verifyOtpHash", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", Date)
], User.prototype, "verifyOtpExpiresAt", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "resetOtpHash", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", Date)
], User.prototype, "resetOtpExpiresAt", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: Object, default: {} }),
    __metadata("design:type", Object)
], User.prototype, "oauthProviders", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: false }),
    __metadata("design:type", Boolean)
], User.prototype, "twoFactorEnabled", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "twoFactorSecretEncrypted", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", Date)
], User.prototype, "twoFactorEnabledAt", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], User.prototype, "twoFactorPendingSecretEncrypted", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", Date)
], User.prototype, "twoFactorPendingSecretExpiresAt", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [TwoFactorBackupCode], default: [] }),
    __metadata("design:type", Array)
], User.prototype, "twoFactorBackupCodes", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [SessionEntry], default: [] }),
    __metadata("design:type", Array)
], User.prototype, "sessions", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [PushSubscriptionEntry], default: [] }),
    __metadata("design:type", Array)
], User.prototype, "pushSubscriptions", void 0);
__decorate([
    (0, mongoose_1.Prop)({
        type: Object,
        default: { desktopPush: true, mobilePush: true, email: true },
    }),
    __metadata("design:type", Object)
], User.prototype, "notificationPreferences", void 0);
exports.User = User = __decorate([
    (0, mongoose_1.Schema)({ timestamps: true })
], User);
exports.UserSchema = mongoose_1.SchemaFactory.createForClass(User);
//# sourceMappingURL=user.schema.js.map