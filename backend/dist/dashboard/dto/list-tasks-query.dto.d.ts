export declare class ListTasksQueryDto {
    status?: 'todo' | 'in_progress' | 'done';
    dateFrom?: string;
    dateTo?: string;
    mine?: boolean;
}
