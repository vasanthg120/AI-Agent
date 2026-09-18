import { JwtPayload } from '../auth/jwt-payload.interface';
import { GetOverviewQueryDto } from './dto/get-overview-query.dto';
import { GetTrendQueryDto } from './dto/get-trend-query.dto';
import { DashboardService } from './dashboard.service';
export declare class DashboardController {
    private dashboardService;
    constructor(dashboardService: DashboardService);
    overview(query: GetOverviewQueryDto, user: JwtPayload): Promise<{
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
    trend(query: GetTrendQueryDto, user: JwtPayload): Promise<{
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
