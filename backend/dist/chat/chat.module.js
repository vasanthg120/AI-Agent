"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatModule = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const redis_cache_service_1 = require("../common/redis/redis-cache.service");
const auth_module_1 = require("../auth/auth.module");
const users_module_1 = require("../users/users.module");
const agent_role_schema_1 = require("../agent-roles/schemas/agent-role.schema");
const chat_attachment_schema_1 = require("./schemas/chat-attachment.schema");
const conversation_schema_1 = require("./schemas/conversation.schema");
const chat_attachments_controller_1 = require("./chat-attachments.controller");
const chat_attachments_service_1 = require("./chat-attachments.service");
const chat_controller_1 = require("./chat.controller");
const chat_gateway_1 = require("./chat.gateway");
const chat_service_1 = require("./chat.service");
let ChatModule = class ChatModule {
};
exports.ChatModule = ChatModule;
exports.ChatModule = ChatModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([
                { name: conversation_schema_1.Conversation.name, schema: conversation_schema_1.ConversationSchema },
                { name: chat_attachment_schema_1.ChatAttachment.name, schema: chat_attachment_schema_1.ChatAttachmentSchema },
                { name: agent_role_schema_1.AgentRole.name, schema: agent_role_schema_1.AgentRoleSchema },
            ]),
            axios_1.HttpModule.register({ timeout: 300_000 }),
            auth_module_1.AuthModule,
            users_module_1.UsersModule,
        ],
        controllers: [chat_attachments_controller_1.ChatAttachmentsController, chat_controller_1.ChatController],
        providers: [chat_service_1.ChatService, chat_attachments_service_1.ChatAttachmentsService, chat_gateway_1.ChatGateway, redis_cache_service_1.RedisCacheService],
        exports: [chat_service_1.ChatService, chat_gateway_1.ChatGateway],
    })
], ChatModule);
//# sourceMappingURL=chat.module.js.map