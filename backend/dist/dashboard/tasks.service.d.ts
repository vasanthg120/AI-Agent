import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { ChatService } from '../chat/chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Achievement } from '../gamification/achievements';
import { GamificationService } from '../gamification/gamification.service';
import { TimelineService } from '../timeline/timeline.service';
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
export interface TaskRecommendation {
    taskId: string;
    rationale: string;
}
export declare class TasksService {
    private reportModel;
    private chatService;
    private http;
    private config;
    private jwt;
    private gamificationService;
    private timelineService;
    private readonly agentUrl;
    constructor(reportModel: Model<DailyReportDocument>, chatService: ChatService, http: HttpService, config: ConfigService, jwt: JwtService, gamificationService: GamificationService, timelineService: TimelineService);
    list(query: ListTasksQueryDto, caller: JwtPayload): Promise<{
        tasks: TaskOut[];
    }>;
    calendarSummary(month: string, caller: JwtPayload, mine?: boolean): Promise<{
        month: string;
        days: {
            reportCount: number;
            taskCount: number;
            hasUrgent: boolean;
            date: string;
        }[];
    }>;
    getRecommendations(caller: JwtPayload): Promise<{
        recommendations: (TaskRecommendation & {
            task: TaskOut;
        })[];
        overallNote: string;
    }>;
    updateStatus(taskId: string, status: 'todo' | 'in_progress' | 'done', caller: JwtPayload): Promise<{
        id: string;
        status: "done" | "todo" | "in_progress";
        newAchievements: Achievement[];
    }>;
}
