import { Model } from 'mongoose';
import { ChatService } from '../chat/chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Achievement } from '../gamification/achievements';
import { GamificationService } from '../gamification/gamification.service';
import { TimelineService } from '../timeline/timeline.service';
import { AccountDocument } from '../crm/schemas/account.schema';
import { ContactDocument } from '../crm/schemas/contact.schema';
import { DealDocument } from '../crm/schemas/deal.schema';
import { QuoteDocument } from '../crm/schemas/quote.schema';
import { EmailIntelligenceItemDocument } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { DailyReportDocument } from './schemas/daily-report.schema';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
export interface TaskOut {
    id: string;
    title: string;
    priority: 'urgent' | 'high' | 'medium' | 'low';
    category?: string;
    isOverdue: boolean;
    status: 'todo' | 'in_progress' | 'done';
    agentId: string;
    reportId: string;
    reportType: 'morning' | 'eod';
    date: string;
    assignedUserId?: string;
}
export interface EodSummary {
    date: string;
    tasksCompleted: TaskOut[];
    tasksPending: TaskOut[];
    email: {
        received: number;
        sent: number;
        responded: number;
        pending: number;
    };
    crm: {
        dealsCreated: number;
        dealsUpdated: number;
        quotesCreated: number;
        quotesUpdated: number;
    };
    newContactsAcrossOrg: number;
    newAccountsAcrossOrg: number;
    narrativeSummary: string | null;
    reportExists: boolean;
    reportGeneratedAt: Date | null;
}
export declare class TasksService {
    private reportModel;
    private dealModel;
    private quoteModel;
    private contactModel;
    private accountModel;
    private emailModel;
    private chatService;
    private gamificationService;
    private timelineService;
    constructor(reportModel: Model<DailyReportDocument>, dealModel: Model<DealDocument>, quoteModel: Model<QuoteDocument>, contactModel: Model<ContactDocument>, accountModel: Model<AccountDocument>, emailModel: Model<EmailIntelligenceItemDocument>, chatService: ChatService, gamificationService: GamificationService, timelineService: TimelineService);
    list(query: ListTasksQueryDto, caller: JwtPayload): Promise<{
        tasks: TaskOut[];
    }>;
    calendarSummary(month: string, caller: JwtPayload, mine?: boolean, reportType?: 'morning' | 'eod'): Promise<{
        month: string;
        days: {
            reportCount: number;
            taskCount: number;
            hasUrgent: boolean;
            date: string;
        }[];
    }>;
    getEodSummary(caller: JwtPayload, requestedDate?: string): Promise<EodSummary>;
    updateStatus(taskId: string, status: 'todo' | 'in_progress' | 'done', caller: JwtPayload): Promise<{
        id: string;
        status: "done" | "todo" | "in_progress";
        newAchievements: Achievement[];
    }>;
}
