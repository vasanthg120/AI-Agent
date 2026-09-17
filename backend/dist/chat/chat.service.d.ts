import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { AgentRoleDocument } from '../agent-roles/schemas/agent-role.schema';
import { ConversationDocument } from './schemas/conversation.schema';
import { JwtPayload } from '../auth/jwt-payload.interface';
export interface StreamEvent {
    type: 'delta' | 'progress' | 'reasoning' | 'plan' | 'agent_done' | 'reflecting';
    text?: string;
    tool?: string;
    agents?: string[];
    agent?: string;
    reason?: string;
}
export declare class ChatService {
    private conversationModel;
    private agentRoleModel;
    private http;
    private config;
    private cache;
    private jwt;
    private readonly logger;
    private readonly agentUrl;
    constructor(conversationModel: Model<ConversationDocument>, agentRoleModel: Model<AgentRoleDocument>, http: HttpService, config: ConfigService, cache: RedisCacheService, jwt: JwtService);
    listAgents(caller?: JwtPayload): Promise<Omit<{
        assignedDepartments: string[];
        assignedUserIds: string[];
        id: string;
        name: string;
        description: string;
        avatarColor: string;
    }, "assignedDepartments" | "assignedUserIds">[]>;
    listConversations(userId: string): Promise<{}>;
    getConversation(userId: string, conversationId: string): Promise<{} | null>;
    renameConversation(userId: string, conversationId: string, title: string): Promise<void>;
    setConversationFlag(userId: string, conversationId: string, flag: 'pinned' | 'favorite' | 'archived', value: boolean): Promise<void>;
    deleteConversation(userId: string, conversationId: string): Promise<void>;
    sendMessage(userId: string, organizationId: string, userJwt: string, message: string, conversationId?: string, agentId?: string): Promise<{
        conversationId: string;
        reply: string;
        toolsUsed: string[];
        suggestions: string[];
    }>;
    sendMessageStreaming(userId: string, organizationId: string, userJwt: string, message: string, conversationId: string | undefined, onEvent: (event: StreamEvent) => void, agentId?: string, onConversationId?: (id: string) => void): Promise<{
        conversationId: string;
        reply: string;
        toolsUsed: string[];
        suggestions: string[];
    }>;
    generateSystemConversation(userId: string, organizationId: string, agentId: string, promptText: string, title: string): Promise<{
        conversationId: string;
        reply: string;
        toolsUsed: string[];
        suggestions: string[];
    }>;
    private getOrCreateConversation;
    private resolveConversationAgent;
    private finishTurn;
    private callAgent;
    private callAgentStreaming;
    cancelAgent(conversationId: string, userJwt: string): Promise<void>;
}
