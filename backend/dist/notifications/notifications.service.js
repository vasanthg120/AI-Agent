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
var NotificationsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const chat_gateway_1 = require("../chat/chat.gateway");
const mail_service_1 = require("../mail/mail.service");
const organizations_service_1 = require("../organizations/organizations.service");
const users_service_1 = require("../users/users.service");
const notification_schema_1 = require("./schemas/notification.schema");
const web_push_service_1 = require("./web-push.service");
const DEFAULT_PREFS = { desktopPush: true, mobilePush: true, email: true };
const DEFAULT_POLICY = { emailEnabled: true, pushEnabled: true };
let NotificationsService = NotificationsService_1 = class NotificationsService {
    constructor(notificationModel, chatGateway, usersService, organizationsService, mailService, webPushService) {
        this.notificationModel = notificationModel;
        this.chatGateway = chatGateway;
        this.usersService = usersService;
        this.organizationsService = organizationsService;
        this.mailService = mailService;
        this.webPushService = webPushService;
        this.logger = new common_1.Logger(NotificationsService_1.name);
    }
    async create(userId, dto, organizationId) {
        const notification = await this.notificationModel.create({ userId, organizationId, ...dto });
        this.chatGateway.emitToUser(userId, 'notification', notification);
        void this.dispatchExternalChannels(userId, organizationId, notification);
        return notification;
    }
    async dispatchExternalChannels(userId, organizationId, notification) {
        try {
            const email = await this.resolveEmailRecipient(userId, organizationId);
            if (email) {
                void this.mailService.sendNotificationEmail(email, notification.title, notification.description);
            }
            const user = await this.usersService.findById(userId);
            if (!user)
                return;
            const orgPolicy = organizationId
                ? await this.organizationsService.getNotificationPolicy(organizationId)
                : DEFAULT_POLICY;
            const prefs = user.notificationPreferences ?? DEFAULT_PREFS;
            if ((prefs.desktopPush || prefs.mobilePush) && orgPolicy.pushEnabled) {
                void this.webPushService.sendToUser(userId, { title: notification.title, body: notification.description }, { allowDesktop: prefs.desktopPush, allowMobile: prefs.mobilePush });
            }
        }
        catch (err) {
            this.logger.warn(`Failed to dispatch external notification channels: ${err.message}`);
        }
    }
    async resolveEmailRecipient(userId, organizationId) {
        const user = await this.usersService.findById(userId);
        if (!user)
            return null;
        const orgPolicy = organizationId ? await this.organizationsService.getNotificationPolicy(organizationId) : DEFAULT_POLICY;
        const prefs = user.notificationPreferences ?? DEFAULT_PREFS;
        return prefs.email && orgPolicy.emailEnabled ? user.email : null;
    }
    list(userId) {
        return this.notificationModel.find({ userId }).sort({ createdAt: -1 }).limit(50).exec();
    }
    async markRead(userId, id) {
        await this.notificationModel.updateOne({ _id: id, userId }, { read: true }).exec();
    }
    async markAllRead(userId) {
        await this.notificationModel.updateMany({ userId, read: false }, { read: true }).exec();
    }
    async getPreferences(userId, organizationId) {
        const user = await this.usersService.findById(userId);
        const orgPolicy = organizationId
            ? await this.organizationsService.getNotificationPolicy(organizationId)
            : DEFAULT_POLICY;
        return { ...(user?.notificationPreferences ?? DEFAULT_PREFS), orgPolicy };
    }
    async updatePreferences(userId, patch) {
        await this.usersService.updateNotificationPreferences(userId, patch);
    }
};
exports.NotificationsService = NotificationsService;
exports.NotificationsService = NotificationsService = NotificationsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(notification_schema_1.Notification.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        chat_gateway_1.ChatGateway,
        users_service_1.UsersService,
        organizations_service_1.OrganizationsService,
        mail_service_1.MailService,
        web_push_service_1.WebPushService])
], NotificationsService);
//# sourceMappingURL=notifications.service.js.map