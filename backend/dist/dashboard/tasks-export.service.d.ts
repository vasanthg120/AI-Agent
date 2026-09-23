import { EodSummary, TaskOut } from './tasks.service';
export declare class TasksExportService {
    toCsv(tasks: TaskOut[]): string;
    writePdf(doc: PDFKit.PDFDocument, tasks: TaskOut[], meta: {
        dateFrom?: string;
        dateTo?: string;
    }): void;
    toEodCsv(summary: EodSummary): string;
    writeEodPdf(doc: PDFKit.PDFDocument, summary: EodSummary): void;
}
