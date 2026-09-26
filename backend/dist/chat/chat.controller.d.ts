import { Request } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ChatService } from './chat.service';
import { RenameConversationDto } from './dto/rename-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SetConversationFlagDto } from './dto/set-conversation-flag.dto';
export declare class ChatController {
    private chatService;
    constructor(chatService: ChatService);
    listAgents(user: JwtPayload): Promise<Omit<{
        assignedDepartments: string[];
        assignedUserIds: string[];
        id: string;
        name: string;
        description: string;
        avatarColor: string;
    }, "assignedDepartments" | "assignedUserIds">[]>;
    listConversations(user: JwtPayload): Promise<{}>;
    getConversation(user: JwtPayload, id: string): Promise<{} | null>;
    renameConversation(user: JwtPayload, id: string, dto: RenameConversationDto): Promise<{
        status: string;
    }>;
    setConversationFlag(user: JwtPayload, id: string, dto: SetConversationFlagDto): Promise<{
        status: string;
    }>;
    deleteConversation(user: JwtPayload, id: string): Promise<{
        status: string;
    }>;
    sendMessage(user: JwtPayload, req: Request, dto: SendMessageDto): Promise<{
        conversationId: string;
        reply: string;
        toolsUsed: string[];
        suggestions: string[];
    }>;
    private assertAiAccessAllowed;
}
