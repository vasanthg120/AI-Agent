import { Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ExportTasksQueryDto } from './dto/export-tasks-query.dto';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TasksExportService } from './tasks-export.service';
import { TasksService } from './tasks.service';
export declare class TasksController {
    private tasksService;
    private tasksExportService;
    constructor(tasksService: TasksService, tasksExportService: TasksExportService);
    list(query: ListTasksQueryDto, user: JwtPayload): Promise<{
        tasks: import("./tasks.service").TaskOut[];
    }>;
    calendar(month: string, mine: string | undefined, reportType: string | undefined, user: JwtPayload): Promise<{
        month: string;
        days: {
            reportCount: number;
            taskCount: number;
            hasUrgent: boolean;
            date: string;
        }[];
    }>;
    eodSummary(date: string | undefined, user: JwtPayload): Promise<import("./tasks.service").EodSummary>;
    export(query: ExportTasksQueryDto, user: JwtPayload, res: Response): Promise<void>;
    eodExport(date: string | undefined, format: 'csv' | 'pdf' | undefined, user: JwtPayload, res: Response): Promise<void>;
    updateStatus(id: string, dto: UpdateTaskStatusDto, user: JwtPayload): Promise<{
        id: string;
        status: "done" | "todo" | "in_progress";
        newAchievements: import("../gamification/achievements").Achievement[];
    }>;
}
