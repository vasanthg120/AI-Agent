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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const auth_service_1 = require("./auth.service");
const register_dto_1 = require("./dto/register.dto");
const login_dto_1 = require("./dto/login.dto");
const verify_otp_dto_1 = require("./dto/verify-otp.dto");
const resend_otp_dto_1 = require("./dto/resend-otp.dto");
const forgot_password_dto_1 = require("./dto/forgot-password.dto");
const reset_password_dto_1 = require("./dto/reset-password.dto");
const change_password_dto_1 = require("./dto/change-password.dto");
const invitation_dto_1 = require("./dto/invitation.dto");
const jwt_auth_guard_1 = require("../common/guards/jwt-auth.guard");
const require_session_auth_guard_1 = require("../common/guards/require-session-auth.guard");
const current_user_decorator_1 = require("../common/decorators/current-user.decorator");
const jwt_payload_interface_1 = require("./jwt-payload.interface");
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };
function sessionMeta(req) {
    return { userAgent: req.headers['user-agent'], ip: req.ip };
}
let AuthController = class AuthController {
    constructor(authService) {
        this.authService = authService;
    }
    register(dto, req) {
        return this.authService.register(dto.email, dto.password, dto.name, dto.organizationName, sessionMeta(req));
    }
    login(dto, req) {
        return this.authService.login(dto.email, dto.password, sessionMeta(req));
    }
    async verifyOtp(dto) {
        await this.authService.verifyEmail(dto.email, dto.otp);
        return { verified: true };
    }
    async resendOtp(dto) {
        await this.authService.resendVerificationOtp(dto.email);
        return { sent: true };
    }
    forgotPassword(dto) {
        return this.authService.forgotPassword(dto.email);
    }
    async resetPassword(dto) {
        await this.authService.resetPassword(dto.email, dto.otp, dto.password);
        return { success: true };
    }
    verifyInvitation(dto) {
        return this.authService.describeInvitation(dto.token);
    }
    acceptInvitation(dto, req) {
        return this.authService.acceptInvitation(dto.token, dto.password, sessionMeta(req));
    }
    async changePassword(user, dto, req) {
        await this.authService.changePassword((0, jwt_payload_interface_1.loginIdOf)(user), dto.currentPassword, dto.newPassword, user.jti, req.ip);
        return { success: true };
    }
    async logout(user) {
        await this.authService.logout((0, jwt_payload_interface_1.loginIdOf)(user), user.jti);
        return { success: true };
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('register'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [register_dto_1.RegisterDto, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "register", null);
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('login'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [login_dto_1.LoginDto, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "login", null);
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('verify-otp'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [verify_otp_dto_1.VerifyOtpDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "verifyOtp", null);
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('resend-otp'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [resend_otp_dto_1.ResendOtpDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "resendOtp", null);
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('forgot-password'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [forgot_password_dto_1.ForgotPasswordDto]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "forgotPassword", null);
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('reset-password'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [reset_password_dto_1.ResetPasswordDto]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "resetPassword", null);
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('invitation/verify'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [invitation_dto_1.VerifyInvitationDto]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "verifyInvitation", null);
__decorate([
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('invitation/accept'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [invitation_dto_1.AcceptInvitationDto, Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "acceptInvitation", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, require_session_auth_guard_1.RequireSessionAuthGuard),
    (0, throttler_1.Throttle)(AUTH_THROTTLE),
    (0, common_1.Post)('change-password'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, change_password_dto_1.ChangePasswordDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "changePassword", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, require_session_auth_guard_1.RequireSessionAuthGuard),
    (0, common_1.Post)('logout'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
exports.AuthController = AuthController = __decorate([
    (0, common_1.Controller)('auth'),
    __metadata("design:paramtypes", [auth_service_1.AuthService])
], AuthController);
//# sourceMappingURL=auth.controller.js.map