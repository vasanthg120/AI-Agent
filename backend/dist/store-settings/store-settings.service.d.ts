import { ChatService } from '../chat/chat.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TimelineService } from '../timeline/timeline.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { OrganizationsService } from '../organizations/organizations.service';
import { StoreDocument } from '../organizations/schemas/store.schema';
import { UsersService } from '../users/users.service';
export declare function todayStamp(tz: string): string;
export declare class StoreSettingsService {
    private organizationsService;
    private chatService;
    private dashboardService;
    private usersService;
    private notificationsService;
    private timelineService;
    private mailService;
    private readonly logger;
    constructor(organizationsService: OrganizationsService, chatService: ChatService, dashboardService: DashboardService, usersService: UsersService, notificationsService: NotificationsService, timelineService: TimelineService, mailService: MailService);
    getSettings(caller: JwtPayload): Promise<StoreDocument>;
    updateSettings(caller: JwtPayload, patch: {
        openingTime?: string;
        closingTime?: string;
        timezone?: string;
    }): Promise<StoreDocument>;
    runNow(caller: JwtPayload, type: 'morning' | 'eod'): Promise<{
        usersNotified: number;
        totalUsers: number;
    }>;
    checkAndRunDailyJobs(): Promise<void>;
    private runForStore;
    private sendEodEmail;
}
