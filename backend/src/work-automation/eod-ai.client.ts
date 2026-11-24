import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { ReservationService } from '../billing/reservation.service';
import type { EmailContent } from '../mail/templates';
import { EodSections } from './schemas/eod-report.schema';

export interface MeetingsResult {
  connected: boolean;
  meetings: { title: string; start: string; end: string; organizer?: string }[];
}

/** Calls to python-agent for the two AI-side pieces of the EOD. Business logic and persistence stay in NestJS. */
@Injectable()
export class EodAiClient {
  private readonly logger = new Logger(EodAiClient.name);
  private readonly agentUrl: string;

  constructor(
    private http: HttpService,
    config: ConfigService,
    private jwt: JwtService,
    private reservations: ReservationService,
  ) {
    this.agentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private headers(userId: string, organizationId: string) {
    return { Authorization: `Bearer ${this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '5m' })}` };
  }

  /** The employee's Outlook calendar for [start, end). Throws on a transport error; the caller records the gap. */
  async meetings(organizationId: string, userId: string, start: Date, end: Date): Promise<MeetingsResult> {
    const res = await firstValueFrom(
      this.http.post<MeetingsResult>(`${this.agentUrl}/work/meetings`, { start: start.toISOString(), end: end.toISOString() }, { headers: this.headers(userId, organizationId), timeout: 30_000 }),
    );
    return res.data;
  }

  /** Sends one email from `senderUserId`'s own connected mailbox (python-agent only ever uses the token's own user; token refresh happens there). Returns the provider reply. Throws on refusal so the caller can fall back. */
  async sendMail(organizationId: string, senderUserId: string, channel: 'gmail' | 'outlook', to: string[], content: EmailContent): Promise<unknown> {
    const res = await firstValueFrom(
      this.http.post(`${this.agentUrl}/work/send-mail`, { channel, to, subject: content.subject, html: content.html, text: content.text }, { headers: this.headers(senderUserId, organizationId), timeout: 45_000 }),
    );
    return res.data;
  }

  /**
   * The narrative of the report, written from the verified sections only.
   * Billed like the other scheduled-report AI calls; returns null (and the
   * caller falls back to a deterministic summary) when billing refuses or the
   * call fails — a report is never withheld because the AI was unavailable.
   */
  async summarize(organizationId: string, userId: string, employeeName: string, date: string, sections: EodSections, dataGaps: string[]): Promise<string | null> {
    const requestId = randomUUID();
    try {
      await this.reservations.reserve(this.reservations.resolveTenantKey(organizationId, userId), userId, requestId, 'work-eod-summary');
    } catch (err) {
      this.logger.warn(`EOD summary skipped for ${userId}: ${(err as Error).message}`);
      return null;
    }
    try {
      const res = await firstValueFrom(
        this.http.post<{ summary: string }>(
          `${this.agentUrl}/work/eod-summary`,
          {
            employee_name: employeeName,
            date,
            completed: sections.completed,
            pending: sections.pending,
            overdue: sections.overdue,
            blocked: sections.blocked,
            awaiting_verification: sections.awaitingVerification,
            meetings: sections.meetings.items,
            customer_followups: sections.customerFollowUps,
            crm_updates: sections.crmUpdates,
            next_day_priorities: sections.nextDayPriorities,
            data_gaps: dataGaps,
            assessment: sections.assessment ?? {},
          },
          { headers: this.headers(userId, organizationId), timeout: 60_000 },
        ),
      );
      await this.reservations.settle(requestId);
      const text = res.data.summary?.trim();
      return text ? text : null;
    } catch (err) {
      await this.reservations.release(requestId).catch(() => undefined);
      this.logger.warn(`EOD AI summary failed for ${userId}: ${(err as Error).message}`);
      return null;
    }
  }
}
