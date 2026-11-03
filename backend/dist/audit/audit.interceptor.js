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
exports.AuditInterceptor = void 0;
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
const audit_service_1 = require("./audit.service");
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIP_ROUTE_PREFIX = '/auth';
let AuditInterceptor = class AuditInterceptor {
    constructor(auditService) {
        this.auditService = auditService;
    }
    intercept(context, next) {
        const request = context.switchToHttp().getRequest();
        const method = request.method;
        const route = request.originalUrl ?? request.url;
        if (!MUTATING_METHODS.has(method) || route.startsWith(SKIP_ROUTE_PREFIX)) {
            return next.handle();
        }
        const start = Date.now();
        const record = (statusCode) => {
            void this.auditService.log({
                userId: request.user?.sub ?? 'anonymous',
                organizationId: request.user?.organizationId,
                method,
                route,
                statusCode,
                durationMs: Date.now() - start,
                ip: request.ip,
                ...(request.user?.loginUserId ? { metadata: { loginUserId: request.user.loginUserId } } : {}),
            });
        };
        return next.handle().pipe((0, rxjs_1.tap)(() => record(context.switchToHttp().getResponse().statusCode)), (0, rxjs_1.catchError)((err) => {
            record(err.status ?? 500);
            return (0, rxjs_1.throwError)(() => err);
        }));
    }
};
exports.AuditInterceptor = AuditInterceptor;
exports.AuditInterceptor = AuditInterceptor = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [audit_service_1.AuditService])
], AuditInterceptor);
//# sourceMappingURL=audit.interceptor.js.map