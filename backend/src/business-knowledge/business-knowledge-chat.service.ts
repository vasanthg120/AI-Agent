import { randomUUID } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { ReservationService } from '../billing/reservation.service';

export interface BusinessKnowledgeChatSource {
  index: number;
  sourceType: string;
  documentId?: string;
  filename?: string;
  snippet: string;
}

export interface BusinessKnowledgeChatResult {
  answer: string;
  sources: BusinessKnowledgeChatSource[];
  creditsCharged: number;
}

/**
 * The first non-chat feature to be metered: reuses ReservationService's
 * reserve/settle/release exactly as chat.py already does (see
 * reservation.service.ts's own header comment), just initiated from NestJS
 * instead of Python — this route calls out to python-agent rather than the
 * other way around. A 402 from reserve() propagates as-is; the frontend
 * already knows how to render that shape from the existing chat flow.
 */
@Injectable()
export class BusinessKnowledgeChatService {
  private readonly logger = new Logger(BusinessKnowledgeChatService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
    private reservations: ReservationService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async ask(organizationId: string, userId: string, question: string): Promise<BusinessKnowledgeChatResult> {
    const requestId = randomUUID();
    // conversationId: this endpoint has no chat conversation of its own —
    // 'business-knowledge' is a stable, readable label, never read back for
    // routing (reserve() only persists it on the CreditReservation row).
    await this.reservations.reserve(organizationId, userId, requestId, 'business-knowledge');

    try {
      const token = this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<{ answer: string; sources: BusinessKnowledgeChatSource[] }>(
          `${this.pythonAgentUrl}/business-knowledge/chat`,
          { organizationId, question, requestId },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      const settlement = await this.reservations.settle(requestId);
      return { answer: data.answer, sources: data.sources, creditsCharged: settlement.creditsCharged };
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`Business knowledge chat failed for org ${organizationId}: ${(err as Error).message}`);
      throw err;
    }
  }
}
