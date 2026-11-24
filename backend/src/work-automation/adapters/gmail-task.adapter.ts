import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { SourceTask } from '../task-types';
import { CollectContext, CollectResult, MAX_SOURCE_ROWS, RecordReader, TaskSourceAdapter } from './task-source-adapter';

export interface GmailKnownThread {
  threadId: string;
  kind: string;
  lastMessageId?: string;
  lastMessageAt?: string;
  reason?: string;
}

export interface GmailActionsResult {
  connected: boolean;
  mailbox: string | null;
  open: { threadId: string; kind: 'reply_owed' | 'promised_followup'; messageId: string; subject: string; counterpart: string; at: string; reason?: string; dueHint?: string }[];
  resolved: { threadId: string; kind: string; messageId: string; at: string; how: 'replied' | 'followup_sent' }[];
  classifier: string;
  /** True only when the whole look-back window was read and the AI check worked. */
  complete: boolean;
  scanned: number;
}

/** Where the actionable-thread read comes from (python-agent holds the Gmail tokens). Replaceable in tests. */
export abstract class GmailActionsSource {
  abstract actions(organizationId: string, userId: string, lookbackDays: number, known: GmailKnownThread[]): Promise<GmailActionsResult>;
}

@Injectable()
export class HttpGmailActionsSource extends GmailActionsSource {
  private readonly agentUrl: string;
  constructor(
    private http: HttpService,
    config: ConfigService,
    private jwt: JwtService,
  ) {
    super();
    this.agentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async actions(organizationId: string, userId: string, lookbackDays: number, known: GmailKnownThread[]): Promise<GmailActionsResult> {
    const token = this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '5m' });
    const res = await firstValueFrom(
      this.http.post<GmailActionsResult>(`${this.agentUrl}/work/gmail-actions`, { lookback_days: lookbackDays, known }, { headers: { Authorization: `Bearer ${token}` }, timeout: 120_000 }),
    );
    return res.data;
  }
}

const TYPE = { reply_owed: 'gmail_reply_owed', promised_followup: 'gmail_promise' } as const;

/**
 * Customer emails in a connected Gmail mailbox that genuinely need action: a person asking
 * for something (reply owed) or a promise the employee made in writing (follow-up). Not every
 * email: automated mail is filtered deterministically and the rest goes through a strict AI
 * check; with no AI available nothing new is proposed. The assignee is the mailbox owner (the
 * connection itself is the verified identity), the organization is checked against the
 * user list, and each task points at its Gmail thread. A task is closed only when the
 * employee actually sent a later message in that thread.
 */
@Injectable()
export class GmailTaskAdapter implements TaskSourceAdapter {
  private readonly logger = new Logger(GmailTaskAdapter.name);
  readonly id = 'gmail';
  readonly label = 'Gmail requests & promised follow-ups';
  readonly sourceTypes = ['gmail_reply_owed', 'gmail_promise'] as const;
  readonly description = 'Customer emails in the employee\'s connected Gmail that ask for a reply, and replies or follow-ups the employee promised in writing. Newsletters, notifications and plain conversation are ignored.';

  constructor(
    private reader: RecordReader,
    private source: GmailActionsSource,
  ) {}

  async collect(ctx: CollectContext): Promise<CollectResult> {
    // Organization isolation: only mailboxes of active people of THIS organization.
    const people = await this.reader.find('users', { organizationId: ctx.organizationId, active: true }, { limit: 5000 });
    const orgUsers = new Set(people.map((p) => String(p._id)));
    const wanted = ctx.userId ? (orgUsers.has(ctx.userId) ? [ctx.userId] : []) : [...orgUsers];
    if (wanted.length === 0) return { tasks: [], complete: true, unresolved: 0 };
    const connections = await this.reader.find('gmail_connections', { userId: { $in: wanted }, isActive: true, status: { $ne: 'needs_reauth' } }, { limit: MAX_SOURCE_ROWS });
    const mailboxOwners = [...new Set(connections.map((c) => String(c.userId)))];

    const tasks: SourceTask[] = [];
    let complete = true;
    for (const userId of mailboxOwners) {
      const existing = await this.reader.find('work_tasks', { organizationId: ctx.organizationId, assignedTo: userId, sourceType: { $in: [...this.sourceTypes] }, isActive: true, status: { $ne: 'completed' } }, { limit: 500 });
      const known: GmailKnownThread[] = existing.map((t) => ({
        threadId: String(t.sourceRecordId),
        kind: t.sourceType === TYPE.promised_followup ? 'promised_followup' : 'reply_owed',
        lastMessageId: t.meta?.lastMessageId,
        lastMessageAt: t.meta?.lastMessageAt,
        reason: t.description,
      }));
      let result: GmailActionsResult;
      try {
        result = await this.source.actions(ctx.organizationId, userId, ctx.config.emailLookbackDays, known);
      } catch (err) {
        // This mailbox could not be read: report incomplete so nothing is retired because of it.
        this.logger.warn(`Gmail read failed for ${userId}: ${(err as Error).message}`);
        complete = false;
        continue;
      }
      if (!result.connected || !result.complete) complete = false;
      for (const o of result.open) {
        const customer = o.counterpart || 'a customer';
        tasks.push({
          sourcePlatform: 'gmail',
          sourceType: TYPE[o.kind],
          sourceRecordId: o.threadId,
          assignedTo: userId,
          title: o.kind === 'reply_owed' ? `Reply to ${customer}: ${o.subject.slice(0, 120)}` : `Follow up with ${customer}: ${o.subject.slice(0, 120)}`,
          description: [o.reason, o.dueHint ? `They were told: ${o.dueHint}` : ''].filter(Boolean).join(' · ') || undefined,
          priority: o.dueHint ? 'high' : 'medium',
          sourceStatus: o.kind,
          sourceUrl: `https://mail.google.com/mail/u/0/#all/${o.threadId}`,
          sourceUpdatedAt: new Date(o.at),
          state: 'open',
          meta: { lastMessageId: o.messageId, lastMessageAt: o.at, mailbox: result.mailbox },
        });
      }
      for (const r of result.resolved) {
        tasks.push({
          sourcePlatform: 'gmail',
          sourceType: r.kind === 'promised_followup' ? TYPE.promised_followup : TYPE.reply_owed,
          sourceRecordId: r.threadId,
          assignedTo: userId,
          title: 'Gmail thread',
          priority: 'medium',
          sourceStatus: r.how,
          state: 'closed',
          closure: { kind: 'completed', evidence: { type: 'source_event', detail: r.how === 'replied' ? 'A reply was sent from the Gmail thread.' : 'The promised follow-up was sent in the Gmail thread.', at: new Date(r.at), sourceRef: r.messageId } },
        });
      }
    }
    return { tasks, complete, unresolved: 0 };
  }
}
