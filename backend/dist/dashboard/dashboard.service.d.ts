import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { ReservationService } from '../billing/reservation.service';
import { ChatService } from '../chat/chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { DealDocument } from '../crm/schemas/deal.schema';
import { QuoteDocument } from '../crm/schemas/quote.schema';
import { EmailIntelligenceItemDocument } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { DailyReport, DailyReportDocument } from './schemas/daily-report.schema';
export declare class DashboardService {
    private reportModel;
    private dealModel;
    private quoteModel;
    private emailModel;
    private http;
    private config;
    private jwt;
    private chatService;
    private reservations;
    private readonly agentUrl;
    constructor(reportModel: Model<DailyReportDocument>, dealModel: Model<DealDocument>, quoteModel: Model<QuoteDocument>, emailModel: Model<EmailIntelligenceItemDocument>, http: HttpService, config: ConfigService, jwt: JwtService, chatService: ChatService, reservations: ReservationService);
    recordDailyReport(input: {
        organizationId: string;
        storeId: string;
        agentId: string;
        reportType: 'morning' | 'eod';
        date: string;
        conversationId: string;
        userId: string;
        wasMissed?: boolean;
        userIds?: string[];
    }): Promise<import("mongoose").Document<unknown, {}, DailyReportDocument, {}, {}> & DailyReport & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }>;
    private attributeTask;
    markReportEmailStatus(reportId: string, status: 'sent' | 'failed', error?: string): Promise<void>;
    hasReportToday(organizationId: string, storeId: string, reportType: 'morning' | 'eod', date: string): Promise<boolean>;
    getOverview(caller?: JwtPayload, agentId?: string): Promise<{
        date: string;
        agents: {
            id: string;
            name: string;
            avatarColor: string;
            status: "pending" | "reported";
            todaysTaskCount: number;
            lastReportType: "morning" | "eod" | undefined;
            lastReportAt: Date | undefined;
        }[];
        stats: {
            totalTasks: number;
            urgentCount: number;
            overdueCount: number;
            reportsGenerated: number;
            followUpHealthPct: number | null;
        };
        criticalAlerts: {
            agentId: string;
            reportId: string;
            _id: import("mongoose").Types.ObjectId;
            title: string;
            priority: "urgent" | "high" | "medium" | "low";
            category?: string | undefined;
            isOverdue: boolean;
            status: "todo" | "in_progress" | "done";
            relatedDealId?: string | undefined;
            relatedQuoteId?: string | undefined;
            relatedEmailId?: string | undefined;
            assignedUserId?: string | undefined;
        }[];
        recentReports: {
            id: string;
            agentId: string;
            reportType: "morning" | "eod";
            summary: string;
            taskCount: number;
            sourceConversationId: string;
            createdAt: Date;
        }[];
    }>;
    getTrend(agentId: string, days: 7 | 30, caller?: JwtPayload): Promise<{
        agentId: string;
        days: 7 | 30;
        points: {
            followUpHealthPct: number | null;
            totalTasks: number;
            urgentCount: number;
            overdueCount: number;
            date: string;
        }[];
    }>;
}
