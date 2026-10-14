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
var ChatGateway_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatGateway = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const websockets_1 = require("@nestjs/websockets");
const socket_io_1 = require("socket.io");
const users_service_1 = require("../users/users.service");
const chat_service_1 = require("./chat.service");
let ChatGateway = ChatGateway_1 = class ChatGateway {
    constructor(chatService, jwtService, usersService) {
        this.chatService = chatService;
        this.jwtService = jwtService;
        this.usersService = usersService;
        this.logger = new common_1.Logger(ChatGateway_1.name);
    }
    async handleConnection(client) {
        const token = client.handshake.auth?.token ??
            (client.handshake.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        try {
            const payload = this.jwtService.verify(token);
            if (payload.purpose)
                throw new Error('special-purpose token');
            const user = await this.usersService.findById(payload.sub);
            if (!user || user.active === false)
                throw new Error('inactive or missing user');
            if (!payload.jti || !user.sessions.some((s) => s.jti === payload.jti)) {
                throw new Error('revoked or missing session');
            }
            client.data.user = payload;
            client.data.token = token;
            client.join(payload.sub);
            client.join(`session:${payload.jti}`);
        }
        catch {
            this.logger.warn(`Rejected unauthenticated socket ${client.id}`);
            client.emit('error', { message: 'Unauthorized' });
            client.disconnect(true);
        }
    }
    handleDisconnect(client) {
        this.logger.debug(`Socket disconnected: ${client.id}`);
    }
    emitToUser(userId, event, payload) {
        this.server.to(userId).emit(event, payload);
    }
    disconnectSession(jti) {
        const room = `session:${jti}`;
        this.server.to(room).emit('session-revoked');
        this.server.in(room).disconnectSockets(true);
    }
    async onMessage(client, body) {
        const user = client.data.user;
        const token = client.data.token;
        if (!user || !token) {
            client.emit('error', { message: 'Unauthorized' });
            return;
        }
        const agentId = body.agentId ?? (user.roles?.includes('agent_user') ? user.assignedAgentId : undefined);
        let conversationId = body.conversationId;
        const attachmentIds = Array.isArray(body.attachmentIds) && body.attachmentIds.every((id) => typeof id === 'string') ? body.attachmentIds.slice(0, 10) : undefined;
        client.emit('typing', { typing: true });
        try {
            const result = await this.chatService.sendMessageStreaming(user.sub, user.organizationId, token, body.message, body.conversationId, (event) => {
                if (event.type === 'delta') {
                    client.emit('chunk', { conversationId, delta: event.text });
                }
                else if (event.type === 'progress') {
                    client.emit('progress', { conversationId, tool: event.tool });
                }
                else if (event.type === 'reasoning') {
                    client.emit('reasoning', { conversationId, text: event.text });
                }
                else if (event.type === 'plan') {
                    client.emit('plan', { conversationId, agents: event.agents });
                }
                else if (event.type === 'agent_done') {
                    client.emit('agentDone', { conversationId, agent: event.agent });
                }
                else if (event.type === 'reflecting') {
                    client.emit('reflecting', { conversationId, reason: event.reason });
                }
            }, agentId, (resolvedId) => {
                conversationId = resolvedId;
                client.emit('conversationId', { conversationId: resolvedId });
            }, attachmentIds);
            client.emit('typing', { typing: false });
            client.emit('message', result);
        }
        catch (err) {
            this.logger.error(`onMessage failed for conversation ${conversationId}: ${err.message}`);
            client.emit('typing', { typing: false });
            const message = err instanceof common_1.BadRequestException ? err.message : 'Something went wrong generating that reply. Please try again.';
            client.emit('error', { message });
        }
    }
    async onCancel(client, body) {
        const token = client.data.token;
        if (!token || !body.conversationId)
            return;
        await this.chatService.cancelAgent(body.conversationId, token);
    }
};
exports.ChatGateway = ChatGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], ChatGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)('message'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ChatGateway.prototype, "onMessage", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('cancel'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ChatGateway.prototype, "onCancel", null);
exports.ChatGateway = ChatGateway = ChatGateway_1 = __decorate([
    (0, websockets_1.WebSocketGateway)({ namespace: '/chat', cors: { origin: true, credentials: true } }),
    __metadata("design:paramtypes", [chat_service_1.ChatService,
        jwt_1.JwtService,
        users_service_1.UsersService])
], ChatGateway);
//# sourceMappingURL=chat.gateway.js.map