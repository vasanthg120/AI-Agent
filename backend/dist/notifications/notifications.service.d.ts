import { Model } from 'mongoose';
import { ChatGateway } from '../chat/chat.gateway';
import { MailService } from '../mail/mail.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { Notification, NotificationDocument } from './schemas/notification.schema';
import { WebPushService } from './web-push.service';
export declare class NotificationsService {
    private notificationModel;
    private chatGateway;
    private usersService;
    private organizationsService;
    private mailService;
    private webPushService;
    private readonly logger;
    constructor(notificationModel: Model<NotificationDocument>, chatGateway: ChatGateway, usersService: UsersService, organizationsService: OrganizationsService, mailService: MailService, webPushService: WebPushService);
    create(userId: string, dto: CreateNotificationDto, organizationId?: string): Promise<import("mongoose").Document<unknown, {}, NotificationDocument, {}, {}> & Notification & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }>;
    private dispatchExternalChannels;
    resolveEmailRecipient(userId: string, organizationId?: string): Promise<string | null>;
    list(userId: string): Promise<(import("mongoose").Document<unknown, {}, NotificationDocument, {}, {}> & Notification & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    })[]>;
    markRead(userId: string, id: string): Promise<void>;
    markAllRead(userId: string): Promise<void>;
    getPreferences(userId: string, organizationId: string | undefined): Promise<{
        desktopPush: boolean;
        mobilePush: boolean;
        email: boolean;
        orgPolicy: {
            emailEnabled: boolean;
            pushEnabled: boolean;
        };
    }>;
    updatePreferences(userId: string, patch: UpdateNotificationPreferencesDto): Promise<void>;
}
