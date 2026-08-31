"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthModule = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const mongoose_1 = require("@nestjs/mongoose");
const passport_1 = require("@nestjs/passport");
const audit_module_1 = require("../audit/audit.module");
const organizations_module_1 = require("../organizations/organizations.module");
const users_module_1 = require("../users/users.module");
const auth_controller_1 = require("./auth.controller");
const auth_service_1 = require("./auth.service");
const oauth_controller_1 = require("./oauth.controller");
const oauth_service_1 = require("./oauth.service");
const two_factor_controller_1 = require("./two-factor.controller");
const two_factor_service_1 = require("./two-factor.service");
const jwt_strategy_1 = require("./strategies/jwt.strategy");
const admin_jwt_strategy_1 = require("./strategies/admin-jwt.strategy");
const admin_account_schema_1 = require("./schemas/admin-account.schema");
const admin_auth_controller_1 = require("./admin-auth.controller");
const admin_accounts_controller_1 = require("./admin-accounts.controller");
const admin_auth_service_1 = require("./admin-auth.service");
let AuthModule = class AuthModule {
};
exports.AuthModule = AuthModule;
exports.AuthModule = AuthModule = __decorate([
    (0, common_1.Module)({
        imports: [
            users_module_1.UsersModule,
            organizations_module_1.OrganizationsModule,
            audit_module_1.AuditModule,
            mongoose_1.MongooseModule.forFeature([{ name: admin_account_schema_1.AdminAccount.name, schema: admin_account_schema_1.AdminAccountSchema }]),
            passport_1.PassportModule.register({ defaultStrategy: 'jwt' }),
            axios_1.HttpModule.register({ timeout: 15_000 }),
            jwt_1.JwtModule.registerAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    secret: config.get('jwt.secret'),
                    signOptions: { expiresIn: config.get('jwt.expiresIn') },
                }),
            }),
        ],
        controllers: [auth_controller_1.AuthController, oauth_controller_1.OAuthController, two_factor_controller_1.TwoFactorController, admin_auth_controller_1.AdminAuthController, admin_accounts_controller_1.AdminAccountsController],
        providers: [auth_service_1.AuthService, jwt_strategy_1.JwtStrategy, oauth_service_1.OAuthService, two_factor_service_1.TwoFactorService, admin_jwt_strategy_1.AdminJwtStrategy, admin_auth_service_1.AdminAuthService],
        exports: [jwt_1.JwtModule, passport_1.PassportModule],
    })
], AuthModule);
//# sourceMappingURL=auth.module.js.map