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
exports.JwtStrategy = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const passport_1 = require("@nestjs/passport");
const passport_jwt_1 = require("passport-jwt");
const organizations_service_1 = require("../../organizations/organizations.service");
const organization_schema_1 = require("../../organizations/schemas/organization.schema");
const users_service_1 = require("../../users/users.service");
let JwtStrategy = class JwtStrategy extends (0, passport_1.PassportStrategy)(passport_jwt_1.Strategy) {
    constructor(config, usersService, organizationsService) {
        const secret = config.get('jwt.secret');
        if (!secret) {
            throw new Error('JWT_SECRET is not set');
        }
        super({
            jwtFromRequest: passport_jwt_1.ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: secret,
        });
        this.usersService = usersService;
        this.organizationsService = organizationsService;
    }
    async validate(payload) {
        if (!payload?.sub) {
            throw new common_1.UnauthorizedException();
        }
        if (payload.purpose) {
            throw new common_1.UnauthorizedException();
        }
        if (payload.roles?.includes('service')) {
            return { ...payload, authMethod: 'service' };
        }
        const session = await this.usersService.resolveSession(payload);
        if (!session) {
            throw new common_1.UnauthorizedException();
        }
        const { user, login } = session;
        const org = await this.organizationsService.findOrgStatus(user.organizationId);
        if ((0, organization_schema_1.isOrganizationBlocked)(org?.status)) {
            throw new common_1.UnauthorizedException();
        }
        void this.usersService.touchSessionIfStale(login._id.toString(), payload.jti);
        return {
            sub: user._id.toString(),
            email: user.email,
            roles: user.roles,
            organizationId: user.organizationId,
            storeId: user.storeId,
            assignedAgentId: user.assignedAgentId,
            permissions: user.permissions,
            features: user.permissions ? undefined : await this.usersService.resolveFeatures(user),
            department: user.department,
            voiceAccessEnabled: user.voiceAccessEnabled,
            aiAccessEnabled: user.aiAccessEnabled,
            jti: payload.jti,
            exp: payload.exp,
            isSubAccount: !!org?.parentOrganizationId,
            ...(payload.loginUserId ? { loginUserId: payload.loginUserId } : {}),
            authMethod: 'session',
        };
    }
};
exports.JwtStrategy = JwtStrategy;
exports.JwtStrategy = JwtStrategy = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        users_service_1.UsersService,
        organizations_service_1.OrganizationsService])
], JwtStrategy);
//# sourceMappingURL=jwt.strategy.js.map