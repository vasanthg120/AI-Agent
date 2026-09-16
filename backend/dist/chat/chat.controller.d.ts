import { Request } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
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
    sendMessage(user: JwtPayload, req: Request, dto: SendMessageDto): Promise<{
        conversationId: string;
        reply: string;
        toolsUsed: string[];
        suggestions: string[];
    }>;
}
