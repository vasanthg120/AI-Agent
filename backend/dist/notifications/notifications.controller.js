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
exports.NotificationsController = void 0;
const common_1 = require("@nestjs/common");
const current_user_decorator_1 = require("../common/decorators/current-user.decorator");
const jwt_auth_guard_1 = require("../common/guards/jwt-auth.guard");
const session_meta_util_1 = require("../auth/session-meta.util");
const create_notification_dto_1 = require("./dto/create-notification.dto");
const update_notification_preferences_dto_1 = require("./dto/update-notification-preferences.dto");
const push_subscribe_dto_1 = require("./dto/push-subscribe.dto");
const notifications_service_1 = require("./notifications.service");
const web_push_service_1 = require("./web-push.service");
const permission_decorator_1 = require("../common/permissions/permission.decorator");
let NotificationsController = class NotificationsController {
    constructor(notificationsService, webPushService) {
        this.notificationsService = notificationsService;
        this.webPushService = webPushService;
    }
    list(user) {
        return this.notificationsService.list(user.sub);
    }
    create(user, dto) {
        return this.notificationsService.create(user.sub, dto, user.organizationId);
    }
    markRead(user, id) {
        return this.notificationsService.markRead(user.sub, id);
    }
    markAllRead(user) {
        return this.notificationsService.markAllRead(user.sub);
    }
    getPreferences(user) {
        return this.notificationsService.getPreferences(user.sub, user.organizationId);
    }
    async updatePreferences(user, dto) {
        await this.notificationsService.updatePreferences(user.sub, dto);
        return this.notificationsService.getPreferences(user.sub, user.organizationId);
    }
    getVapidPublicKey() {
        return { publicKey: this.webPushService.getPublicKey() };
    }
    async subscribePush(user, dto, req) {
        const userAgent = req.headers['user-agent'];
        await this.webPushService.subscribe(user.sub, {
            endpoint: dto.endpoint,
            keys: dto.keys,
            deviceType: (0, session_meta_util_1.classifyDeviceType)(userAgent),
            userAgent,
            createdAt: new Date(),
            ...(dto.app ? { app: dto.app } : {}),
        });
        return { success: true };
    }
    async unsubscribePush(user, dto) {
        await this.webPushService.unsubscribe(user.sub, dto.endpoint);
        return { success: true };
    }
};
exports.NotificationsController = NotificationsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], NotificationsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_notification_dto_1.CreateNotificationDto]),
    __metadata("design:returntype", void 0)
], NotificationsController.prototype, "create", null);
__decorate([
    (0, common_1.Post)(':id/read'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NotificationsController.prototype, "markRead", null);
__decorate([
    (0, common_1.Post)('read-all'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], NotificationsController.prototype, "markAllRead", null);
__decorate([
    (0, common_1.Get)('preferences'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], NotificationsController.prototype, "getPreferences", null);
__decorate([
    (0, common_1.Put)('preferences'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, update_notification_preferences_dto_1.UpdateNotificationPreferencesDto]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "updatePreferences", null);
__decorate([
    (0, common_1.Get)('push/vapid-public-key'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], NotificationsController.prototype, "getVapidPublicKey", null);
__decorate([
    (0, common_1.Post)('push/subscribe'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, push_subscribe_dto_1.PushSubscribeDto, Object]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "subscribePush", null);
__decorate([
    (0, common_1.Post)('push/unsubscribe'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, push_subscribe_dto_1.PushUnsubscribeDto]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "unsubscribePush", null);
exports.NotificationsController = NotificationsController = __decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, permission_decorator_1.PermissionExempt)('personal'),
    (0, common_1.Controller)('notifications'),
    __metadata("design:paramtypes", [notifications_service_1.NotificationsService,
        web_push_service_1.WebPushService])
], NotificationsController);
//# sourceMappingURL=notifications.controller.js.map