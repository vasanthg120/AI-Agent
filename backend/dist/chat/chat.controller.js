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
exports.ChatController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const jwt_auth_guard_1 = require("../common/guards/jwt-auth.guard");
const current_user_decorator_1 = require("../common/decorators/current-user.decorator");
const chat_service_1 = require("./chat.service");
const rename_conversation_dto_1 = require("./dto/rename-conversation.dto");
const send_message_dto_1 = require("./dto/send-message.dto");
const set_conversation_flag_dto_1 = require("./dto/set-conversation-flag.dto");
const CHAT_THROTTLE = { default: { limit: 20, ttl: 60_000 } };
let ChatController = class ChatController {
    constructor(chatService) {
        this.chatService = chatService;
    }
    listAgents(user) {
        return this.chatService.listAgents(user);
    }
    listConversations(user) {
        return this.chatService.listConversations(user.sub);
    }
    getConversation(user, id) {
        return this.chatService.getConversation(user.sub, id);
    }
    async renameConversation(user, id, dto) {
        await this.chatService.renameConversation(user.sub, id, dto.title);
        return { status: 'ok' };
    }
    async setConversationFlag(user, id, dto) {
        await this.chatService.setConversationFlag(user.sub, id, dto.flag, dto.value);
        return { status: 'ok' };
    }
    async deleteConversation(user, id) {
        await this.chatService.deleteConversation(user.sub, id);
        return { status: 'ok' };
    }
    sendMessage(user, req, dto) {
        const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const agentId = dto.agentId ?? (user.roles.includes('agent_user') ? user.assignedAgentId : undefined);
        return this.chatService.sendMessage(user.sub, user.organizationId, bearerToken, dto.message, dto.conversationId, agentId);
    }
};
exports.ChatController = ChatController;
__decorate([
    (0, common_1.Get)('agents'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ChatController.prototype, "listAgents", null);
__decorate([
    (0, common_1.Get)('conversations'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ChatController.prototype, "listConversations", null);
__decorate([
    (0, common_1.Get)('conversations/:id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ChatController.prototype, "getConversation", null);
__decorate([
    (0, common_1.Patch)('conversations/:id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, rename_conversation_dto_1.RenameConversationDto]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "renameConversation", null);
__decorate([
    (0, common_1.Patch)('conversations/:id/flag'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, set_conversation_flag_dto_1.SetConversationFlagDto]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "setConversationFlag", null);
__decorate([
    (0, common_1.Delete)('conversations/:id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], ChatController.prototype, "deleteConversation", null);
__decorate([
    (0, common_1.Post)('messages'),
    (0, throttler_1.Throttle)(CHAT_THROTTLE),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, send_message_dto_1.SendMessageDto]),
    __metadata("design:returntype", void 0)
], ChatController.prototype, "sendMessage", null);
exports.ChatController = ChatController = __decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('chat'),
    __metadata("design:paramtypes", [chat_service_1.ChatService])
], ChatController);
//# sourceMappingURL=chat.controller.js.map