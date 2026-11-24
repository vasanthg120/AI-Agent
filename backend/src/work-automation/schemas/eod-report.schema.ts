import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export type EodReportDocument = EodReport & Document<Types.ObjectId>;

export interface TaskSnapshot {
  taskId: string;
  title: string;
  priority: string;
  status: string;
  dueDate?: Date;
  sourcePlatform: string;
  sourceType: string;
  sourceUrl?: string;
  /** Completed work only: what proved it. */
  evidence?: { type: string; detail: string; at: Date; verifiedBy?: string };
}

// How to read the day. These are different situations and must never be merged:
//  no_assigned_work  – the connected platforms list nothing assigned to this person
//  no_completed_work – work was assigned, none was finished (and verified) today
//  worked            – verified completed work exists
//  sync_unreliable   – a source could not be read, so the data cannot say what happened
export type EodHeadline = 'worked' | 'no_completed_work' | 'no_assigned_work' | 'sync_unreliable';

export interface EodAssessment {
  headline: EodHeadline;
  assignedWork: boolean;
  completedWork: boolean;
  /** Anything the person demonstrably did today: replies sent, CRM changes, meetings, their own task actions. */
  activityDetected: boolean;
  /** complete only when every activity source (calendar, mail, CRM) could be read. */
  activitySignals: 'complete' | 'partial';
  syncHealth: 'ok' | 'degraded' | 'unknown';
  syncNotes: string[];
}

export interface EodSections {
  assessment?: EodAssessment;
  completed: TaskSnapshot[];
  pending: TaskSnapshot[];
  overdue: TaskSnapshot[];
  blocked: TaskSnapshot[];
  awaitingVerification: TaskSnapshot[];
  meetings: { source: 'outlook_calendar' | 'not_connected' | 'unavailable'; items: { title: string; start: string; end: string; organizer?: string }[] };
  customerFollowUps: { repliesSent: number; completed: TaskSnapshot[]; pending: TaskSnapshot[] };
  crmUpdates: { kind: string; entity: string; customerName?: string; value?: number; currency?: string; at: Date }[];
  nextDayPriorities: TaskSnapshot[];
  counts: { completed: number; pending: number; overdue: number; blocked: number; awaitingVerification: number };
}

export const EOD_STATUSES = ['generating', 'generated', 'failed'] as const;
export type EodStatus = (typeof EOD_STATUSES)[number];

// One employee's end-of-day report for one business day. Built only from
// work_tasks, their recorded events and verified source records; the AI writes
// the narrative from those and cannot add facts. Unique per (organization,
// employee, date): generating twice can never produce two reports.
@Schema({ timestamps: true, collection: 'work_eod_reports' })
export class EodReport {
  @Prop({ required: true, index: true }) organizationId: string;
  @Prop({ required: true, index: true }) userId: string;
  @Prop({ required: true, index: true }) date: string; // business day, "YYYY-MM-DD" in `timezone`
  @Prop({ required: true }) timezone: string;

  @Prop({ required: true, enum: EOD_STATUSES, default: 'generating', index: true }) status: EodStatus;
  @Prop({ default: 0 }) attempts: number;
  @Prop() startedAt?: Date;
  @Prop() generatedAt?: Date;
  @Prop() error?: string;
  // The scheduled run came later than the configured EOD time (e.g. the server was down).
  @Prop({ default: false }) wasMissed: boolean;
  @Prop() trigger?: string;

  @Prop() employeeName?: string;
  @Prop() employeeEmail?: string;
  // The manager at generation time (User.reportingManagerId); delivery re-checks they are still valid.
  @Prop() managerId?: string;

  @Prop({ type: SchemaTypes.Mixed }) sections?: EodSections;
  @Prop() summary?: string;
  @Prop({ enum: ['ai', 'deterministic'] }) summarySource?: 'ai' | 'deterministic';
  // What could not be verified or read, shown on the report so nobody mistakes missing data for a quiet day.
  @Prop({ type: [String], default: [] }) dataGaps: string[];

  createdAt: Date;
  updatedAt: Date;
}

export const EodReportSchema = SchemaFactory.createForClass(EodReport);
EodReportSchema.index({ organizationId: 1, userId: 1, date: 1 }, { unique: true });
EodReportSchema.index({ organizationId: 1, date: 1, status: 1 });
