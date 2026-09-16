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
var ChatService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatService = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const mongoose_1 = require("@nestjs/mongoose");
const rxjs_1 = require("rxjs");
const mongoose_2 = require("mongoose");
const redis_cache_service_1 = require("../common/redis/redis-cache.service");
const agent_role_schema_1 = require("../agent-roles/schemas/agent-role.schema");
const agents_1 = require("./agents");
const conversation_schema_1 = require("./schemas/conversation.schema");
class AgentUserFacingError extends Error {
}
function extractAgentErrorMessage(err) {
    if (err instanceof AgentUserFacingError)
        return err.message;
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string')
        return detail;
    if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
        return detail.message;
    }
    return null;
}
const CACHE_TTL_SECONDS = 45;
function stripAssignment(agent) {
    const { assignedDepartments: _d, assignedUserIds: _u, ...rest } = agent;
    return rest;
}
let ChatService = ChatService_1 = class ChatService {
    constructor(conversationModel, agentRoleModel, http, config, cache, jwt) {
        this.conversationModel = conversationModel;
        this.agentRoleModel = agentRoleModel;
        this.http = http;
        this.config = config;
        this.cache = cache;
        this.jwt = jwt;
        this.logger = new common_1.Logger(ChatService_1.name);
        this.agentUrl = this.config.get('pythonAgentUrl') ?? 'http://localhost:8000';
    }
    async listAgents(caller) {
        const dynamic = caller?.organizationId
            ? await this.agentRoleModel
                .find({ status: 'active', organizationId: caller.organizationId })
                .select({ slug: 1, name: 1, description: 1, avatarColor: 1, assignedDepartments: 1, assignedUserIds: 1 })
                .exec()
            : [];
        const all = [
            ...agents_1.CHAT_AGENTS.map((a) => ({ ...a, assignedDepartments: [], assignedUserIds: [] })),
            ...dynamic.map((d) => ({
                id: d.slug,
                name: d.name,
                description: d.description,
                avatarColor: d.avatarColor,
                assignedDepartments: d.assignedDepartments ?? [],
                assignedUserIds: d.assignedUserIds ?? [],
            })),
        ];
        if (caller?.roles?.includes('agent_user') && !caller.roles.includes('admin')) {
            return all.map(stripAssignment).filter((a) => a.id === caller.assignedAgentId);
        }
        if (caller && !caller.roles.includes('admin') && !caller.roles.includes('owner')) {
            return all
                .filter((a) => (a.assignedDepartments.length === 0 && a.assignedUserIds.length === 0) ||
                (!!caller.department && a.assignedDepartments.includes(caller.department)) ||
                a.assignedUserIds.includes(caller.sub))
                .map(stripAssignment);
        }
        return all.map(stripAssignment);
    }
    async listConversations(userId) {
        const cacheKey = `chat:conversations:${userId}`;
        const cached = await this.cache.get(cacheKey);
        if (cached)
            return cached;
        const result = await this.conversationModel
            .find({ userId })
            .select({ title: 1, updatedAt: 1, createdAt: 1 })
            .sort({ updatedAt: -1 })
            .exec();
        await this.cache.set(cacheKey, result, CACHE_TTL_SECONDS);
        return result;
    }
    async getConversation(userId, conversationId) {
        const cacheKey = `chat:conversation:${userId}:${conversationId}`;
        const cached = await this.cache.get(cacheKey);
        if (cached)
            return cached;
        const result = await this.conversationModel.findOne({ _id: conversationId, userId }).exec();
        if (result)
            await this.cache.set(cacheKey, result, CACHE_TTL_SECONDS);
        return result;
    }
    async sendMessage(userId, organizationId, userJwt, message, conversationId, agentId) {
        const conversation = await this.getOrCreateConversation(userId, organizationId, message, conversationId, agentId);
        const resolvedAgentId = this.resolveConversationAgent(conversation, agentId);
        conversation.messages.push({
            role: 'user',
            content: message,
            toolsUsed: [],
            createdAt: new Date(),
        });
        const agentReply = await this.callAgent(userId, userJwt, conversation._id.toString(), message, resolvedAgentId);
        return this.finishTurn(conversation, agentReply);
    }
    async sendMessageStreaming(userId, organizationId, userJwt, message, conversationId, onEvent, agentId, onConversationId) {
        const conversation = await this.getOrCreateConversation(userId, organizationId, message, conversationId, agentId);
        onConversationId?.(conversation._id.toString());
        const resolvedAgentId = this.resolveConversationAgent(conversation, agentId);
        conversation.messages.push({
            role: 'user',
            content: message,
            toolsUsed: [],
            createdAt: new Date(),
        });
        const agentReply = await this.callAgentStreaming(userId, userJwt, conversation._id.toString(), message, onEvent, resolvedAgentId);
        return this.finishTurn(conversation, agentReply);
    }
    async generateSystemConversation(userId, organizationId, agentId, promptText, title) {
        const conversation = await this.conversationModel.create({ userId, organizationId, title, agentId, messages: [] });
        conversation.messages.push({
            role: 'user',
            content: promptText,
            toolsUsed: [],
            createdAt: new Date(),
        });
        const userJwt = this.jwt.sign({ sub: userId }, { expiresIn: '5m' });
        const agentReply = await this.callAgent(userId, userJwt, conversation._id.toString(), promptText, agentId);
        return this.finishTurn(conversation, agentReply);
    }
    async getOrCreateConversation(userId, organizationId, message, conversationId, agentId) {
        const existing = conversationId
            ? await this.conversationModel.findOne({ _id: conversationId, userId })
            : null;
        if (existing)
            return existing;
        return this.conversationModel.create({
            userId,
            organizationId,
            title: message.slice(0, 60),
            agentId,
            messages: [],
        });
    }
    resolveConversationAgent(conversation, requestedAgentId) {
        if (!conversation.agentId && requestedAgentId) {
            conversation.agentId = requestedAgentId;
        }
        return conversation.agentId;
    }
    async finishTurn(conversation, agentReply) {
        conversation.messages.push({
            role: 'assistant',
            content: agentReply.reply || '[No response — cancelled before any text was generated]',
            toolsUsed: agentReply.tools_used ?? [],
            createdAt: new Date(),
        });
        await conversation.save();
        const userId = conversation.userId;
        const conversationId = conversation._id.toString();
        await this.cache.del(`chat:conversations:${userId}`, `chat:conversation:${userId}:${conversationId}`);
        return {
            conversationId,
            reply: agentReply.reply,
            toolsUsed: agentReply.tools_used ?? [],
        };
    }
    async callAgent(userId, userJwt, conversationId, message, agentId) {
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.agentUrl}/chat`, { user_id: userId, conversation_id: conversationId, message, agent_id: agentId }, { headers: { Authorization: `Bearer ${userJwt}` } }));
            return response.data;
        }
        catch (err) {
            this.logger.error(`python-agent call failed: ${err.message}`);
            const userMessage = extractAgentErrorMessage(err);
            return {
                reply: userMessage ?? "I couldn't reach the AI agent service. Please try again shortly.",
                tools_used: [],
            };
        }
    }
    async callAgentStreaming(userId, userJwt, conversationId, message, onEvent, agentId) {
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.agentUrl}/chat/stream`, { user_id: userId, conversation_id: conversationId, message, agent_id: agentId }, { headers: { Authorization: `Bearer ${userJwt}` }, responseType: 'stream' }));
            return await new Promise((resolve, reject) => {
                let buffer = '';
                let settled = false;
                const stream = response.data;
                stream.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    let boundary;
                    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        if (!frame.startsWith('data: '))
                            continue;
                        let event;
                        try {
                            event = JSON.parse(frame.slice(6));
                        }
                        catch (parseErr) {
                            this.logger.warn(`Skipping malformed SSE frame: ${parseErr.message}`);
                            continue;
                        }
                        if (event.type === 'delta' ||
                            event.type === 'progress' ||
                            event.type === 'reasoning' ||
                            event.type === 'plan' ||
                            event.type === 'agent_done' ||
                            event.type === 'reflecting') {
                            onEvent(event);
                        }
                        else if (event.type === 'done') {
                            settled = true;
                            resolve({ reply: event.reply, tools_used: event.tools_used });
                        }
                        else if (event.type === 'error' || event.type === 'billing_error') {
                            settled = true;
                            reject(new AgentUserFacingError(event.message));
                        }
                    }
                });
                stream.on('end', () => {
                    if (!settled)
                        reject(new Error('Agent stream ended without a final result'));
                });
                stream.on('error', (err) => {
                    if (!settled)
                        reject(err);
                });
            });
        }
        catch (err) {
            this.logger.error(`python-agent streaming call failed: ${err.message}`);
            const userMessage = extractAgentErrorMessage(err);
            return {
                reply: userMessage ?? "I couldn't reach the AI agent service. Please try again shortly.",
                tools_used: [],
            };
        }
    }
    async cancelAgent(conversationId, userJwt) {
        try {
            await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.agentUrl}/chat/stream/cancel`, { conversation_id: conversationId }, { headers: { Authorization: `Bearer ${userJwt}` } }));
        }
        catch (err) {
            this.logger.warn(`Cancel request to python-agent failed: ${err.message}`);
        }
    }
};
exports.ChatService = ChatService;
exports.ChatService = ChatService = ChatService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(conversation_schema_1.Conversation.name)),
    __param(1, (0, mongoose_1.InjectModel)(agent_role_schema_1.AgentRole.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        mongoose_2.Model,
        axios_1.HttpService,
        config_1.ConfigService,
        redis_cache_service_1.RedisCacheService,
        jwt_1.JwtService])
], ChatService);
//# sourceMappingURL=chat.service.js.map