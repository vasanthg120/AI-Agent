import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { firstValueFrom } from 'rxjs';
import { Model } from 'mongoose';
import { AxiosError } from 'axios';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { AgentRole, AgentRoleDocument } from '../agent-roles/schemas/agent-role.schema';
import { CHAT_AGENTS } from './agents';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { JwtPayload } from '../auth/jwt-payload.interface';

interface AgentReply {
  reply: string;
  tools_used?: string[];
  // Contextual follow-up prompts (see python-agent's app.agent.orchestrator
  // ._attach_suggestions) — optional/additive, always [] on the Groq
  // "general" fast lane, never present on the pre-existing failure-fallback
  // replies below.
  suggestions?: string[];
}

// A structured, already-user-safe message python-agent sent on purpose (e.g.
// billing/insufficient-credits — see billing/client.py's to_http_exception
// and routes/chat.py's 'billing_error' SSE frame) — as opposed to a raw
// network/timeout failure. Marks the two call*Agent* catch blocks below so
// they show the caller's real reason instead of overwriting it with the
// generic "couldn't reach the AI agent service" fallback, which used to
// happen unconditionally (including for a real 402 insufficient-balance
// response, which every prior "AI agent unreachable" report in this app
// turned out to actually be).
class AgentUserFacingError extends Error {}

// Pulls a safe, already-human-readable message out of a failed python-agent
// call — either an AgentUserFacingError raised while relaying an SSE frame
// (see callAgentStreaming below), or an HTTPException python-agent itself
// raised with a structured `detail` (e.g. {code, message, ...} for
// INSUFFICIENT_BALANCE — see billing/client.py's to_http_exception). Returns
// null for anything else (a genuine network/timeout/5xx failure), so the
// caller keeps its generic "couldn't reach the AI agent service" fallback
// for those instead of surfacing raw Axios/HTTP internals.
function extractAgentErrorMessage(err: unknown): string | null {
  if (err instanceof AgentUserFacingError) return err.message;
  const detail = (err as AxiosError<{ detail?: unknown }>).response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    return (detail as { message: string }).message;
  }
  return null;
}

export interface StreamEvent {
  type: 'delta' | 'progress' | 'reasoning' | 'plan' | 'agent_done' | 'reflecting';
  text?: string;
  tool?: string;
  agents?: string[];
  agent?: string;
  reason?: string;
}

const CACHE_TTL_SECONDS = 45;

// assignedDepartments/assignedUserIds only exist to compute visibility above
// — not part of the @mention widget's public shape, so they're dropped on
// the way out rather than leaking the org's assignment config to every caller.
function stripAssignment<T extends { assignedDepartments: string[]; assignedUserIds: string[] }>(
  agent: T,
): Omit<T, 'assignedDepartments' | 'assignedUserIds'> {
  const { assignedDepartments: _d, assignedUserIds: _u, ...rest } = agent;
  return rest;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly agentUrl: string;

  constructor(
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    @InjectModel(AgentRole.name) private agentRoleModel: Model<AgentRoleDocument>,
    private http: HttpService,
    private config: ConfigService,
    private cache: RedisCacheService,
    private jwt: JwtService,
  ) {
    this.agentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  /** Static personas + any activated Dynamic Role Generator roles — the
   * source list for chat's @mention widget. Dynamic roles only surface once
   * 'active' (see agent-roles module's draft/active review workflow).
   * When called on behalf of an agent_user (not also admin), scoped down to
   * just their one assigned agent — RBAC boundary, not just a UI filter,
   * since DashboardService.getOverview() also reuses this for its own scoping.
   * Beyond that, non-admin/owner callers only see a custom AgentRole whose
   * assignedDepartments/assignedUserIds (Phase 6, Agent Marketplace) matches
   * them, or that has neither set (org-wide visible, the default for every
   * role created before this existed). Built-in CHAT_AGENTS are always
   * visible to everyone — this filter only governs custom roles. */
  async listAgents(caller?: JwtPayload) {
    // No caller/org context (shouldn't happen behind JwtAuthGuard, but this
    // is also called internally) -> no dynamic org-specific personas, only
    // the shared static ones. Fail closed, not open.
    const dynamic = caller?.organizationId
      ? await this.agentRoleModel
          .find({ status: 'active', organizationId: caller.organizationId })
          .select({ slug: 1, name: 1, description: 1, avatarColor: 1, assignedDepartments: 1, assignedUserIds: 1 })
          .exec()
      : [];
    const all = [
      ...CHAT_AGENTS.map((a) => ({ ...a, assignedDepartments: [] as string[], assignedUserIds: [] as string[] })),
      ...dynamic.map((d) => ({
        id: d.slug,
        name: d.name,
        description: d.description,
        avatarColor: d.avatarColor,
        assignedDepartments: d.assignedDepartments ?? [],
        assignedUserIds: d.assignedUserIds ?? [],
      })),
    ];

    if (caller?.roles?.includes('agent_user') && !caller.roles.includes('admin')) {
      return all.map(stripAssignment).filter((a) => a.id === caller.assignedAgentId);
    }

    if (caller && !caller.roles.includes('admin') && !caller.roles.includes('owner')) {
      return all
        .filter(
          (a) =>
            (a.assignedDepartments.length === 0 && a.assignedUserIds.length === 0) ||
            (!!caller.department && a.assignedDepartments.includes(caller.department)) ||
            a.assignedUserIds.includes(caller.sub),
        )
        .map(stripAssignment);
    }

    return all.map(stripAssignment);
  }

  async listConversations(userId: string) {
    const cacheKey = `chat:conversations:${userId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.conversationModel
      .find({ userId })
      .select({ title: 1, updatedAt: 1, createdAt: 1, pinned: 1, favorite: 1, archived: 1, messages: { $slice: -1 } })
      .sort({ updatedAt: -1 })
      .exec();
    await this.cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  async getConversation(userId: string, conversationId: string) {
    // Cache key deliberately includes userId, not just conversationId — the
    // underlying query enforces ownership via {_id, userId}; keying the
    // cache on conversationId alone would let a cache hit bypass that check
    // for any authenticated user who knew/guessed another user's id.
    const cacheKey = `chat:conversation:${userId}:${conversationId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.conversationModel.findOne({ _id: conversationId, userId }).exec();
    if (result) await this.cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  async renameConversation(userId: string, conversationId: string, title: string): Promise<void> {
    const result = await this.conversationModel.updateOne({ _id: conversationId, userId }, { title }).exec();
    if (result.matchedCount === 0) throw new NotFoundException('Conversation not found');
    await this.cache.del(`chat:conversations:${userId}`, `chat:conversation:${userId}:${conversationId}`);
  }

  async setConversationFlag(
    userId: string,
    conversationId: string,
    flag: 'pinned' | 'favorite' | 'archived',
    value: boolean,
  ): Promise<void> {
    const result = await this.conversationModel.updateOne({ _id: conversationId, userId }, { [flag]: value }).exec();
    if (result.matchedCount === 0) throw new NotFoundException('Conversation not found');
    await this.cache.del(`chat:conversations:${userId}`, `chat:conversation:${userId}:${conversationId}`);
  }

  async deleteConversation(userId: string, conversationId: string): Promise<void> {
    const result = await this.conversationModel.deleteOne({ _id: conversationId, userId }).exec();
    if (result.deletedCount === 0) throw new NotFoundException('Conversation not found');
    await this.cache.del(`chat:conversations:${userId}`, `chat:conversation:${userId}:${conversationId}`);
  }

  async sendMessage(
    userId: string,
    organizationId: string,
    userJwt: string,
    message: string,
    conversationId?: string,
    agentId?: string,
  ) {
    const conversation = await this.getOrCreateConversation(userId, organizationId, message, conversationId, agentId);
    const resolvedAgentId = this.resolveConversationAgent(conversation, agentId);

    conversation.messages.push({
      role: 'user',
      content: message,
      toolsUsed: [],
      createdAt: new Date(),
    });

    const agentReply = await this.callAgent(userId, userJwt, conversation._id.toString(), message, resolvedAgentId);

    return this.finishTurn(conversation, agentReply);
  }

  /** Same as sendMessage, but relays live text/tool-progress events via
   * onEvent as they arrive from python-agent's SSE endpoint, instead of
   * blocking until the whole reply is ready. Used by the WebSocket gateway,
   * which has a socket to push events to — the REST controller has none,
   * so it keeps using the non-streaming sendMessage() above unchanged. */
  async sendMessageStreaming(
    userId: string,
    organizationId: string,
    userJwt: string,
    message: string,
    conversationId: string | undefined,
    onEvent: (event: StreamEvent) => void,
    agentId?: string,
    // Fired the instant the real conversation id is known — for a brand-new
    // conversation that's only now, mid-call, not at the start (there's no
    // id to hand the caller until getOrCreateConversation resolves). The
    // gateway uses this to tell the client the real id early enough that a
    // "stop generating" click during a first message can actually name the
    // right conversation to cancel — without this, the client only learns
    // the real id from the terminal result, by which point it's too late.
    onConversationId?: (id: string) => void,
  ) {
    const conversation = await this.getOrCreateConversation(userId, organizationId, message, conversationId, agentId);
    onConversationId?.(conversation._id.toString());
    const resolvedAgentId = this.resolveConversationAgent(conversation, agentId);

    conversation.messages.push({
      role: 'user',
      content: message,
      toolsUsed: [],
      createdAt: new Date(),
    });

    const agentReply = await this.callAgentStreaming(
      userId,
      userJwt,
      conversation._id.toString(),
      message,
      onEvent,
      resolvedAgentId,
    );

    return this.finishTurn(conversation, agentReply);
  }

  /** Creates a conversation with no live user turn driving it, without an
   * actual LLM call — used by the scheduled morning/EOD report job
   * (store-settings.service.ts's runForStore, via
   * dashboardService.recordDailyReport) to give every store roster user a
   * copy of the already-generated report in their own Chat History. Used to
   * be one full live-agent /chat pipeline call PER roster user (as
   * expensive as interactive chat), even though only the first successful
   * call's conversationId was ever read afterward — the actual report
   * content always came from one separate, independent crew call. That was
   * N real LLM calls per report for content that was N-1 times provably
   * discarded. This persists the SAME already-generated reply text into
   * every user's own Chat History instead, so each user still gets an
   * identical, accurate copy (not a different, lower-quality per-user chat
   * reply) at zero additional LLM cost. Always creates fresh (no
   * existing-conversation lookup). Reuses finishTurn() so the Redis cache
   * invalidation added for live chat covers this write path too. */
  async createSystemConversationRecord(userId: string, organizationId: string, agentId: string, title: string, promptText: string, replyText: string) {
    const conversation = await this.conversationModel.create({ userId, organizationId, title, agentId, messages: [] });
    conversation.messages.push({
      role: 'user',
      content: promptText,
      toolsUsed: [],
      createdAt: new Date(),
    });

    return this.finishTurn(conversation, { reply: replyText, tools_used: [] });
  }

  private async getOrCreateConversation(
    userId: string,
    organizationId: string,
    message: string,
    conversationId?: string,
    agentId?: string,
  ) {
    const existing = conversationId
      ? await this.conversationModel.findOne({ _id: conversationId, userId })
      : null;
    if (existing) return existing;

    return this.conversationModel.create({
      userId,
      organizationId,
      title: message.slice(0, 60),
      agentId,
      messages: [],
    });
  }

  /** A conversation's persona is set once and stays sticky — the first
   * explicit @mention (or none, for the generic assistant) wins for the
   * conversation's lifetime. Ignores requestedAgentId once a conversation
   * already has one (server-side sticky, not trusted per-message from the
   * client) and persists a first-time selection onto the in-memory document
   * (saved along with the rest of the turn in finishTurn()). */
  private resolveConversationAgent(conversation: ConversationDocument, requestedAgentId?: string): string | undefined {
    if (!conversation.agentId && requestedAgentId) {
      conversation.agentId = requestedAgentId;
    }
    return conversation.agentId;
  }

  private async finishTurn(conversation: ConversationDocument, agentReply: AgentReply) {
    conversation.messages.push({
      role: 'assistant',
      // Mongoose's `content: { required: true }` (see schemas/conversation.schema.ts)
      // rejects '' for a String path — not just missing/null — so an
      // empty reply (a turn cancelled before any text streamed, see
      // ChatGateway's 'cancel' handler) would otherwise throw a
      // ValidationError here. Caught via a live cancellation test that hit
      // exactly this.
      content: agentReply.reply || '[No response — cancelled before any text was generated]',
      toolsUsed: agentReply.tools_used ?? [],
      createdAt: new Date(),
    });
    await conversation.save();

    const userId = conversation.userId;
    const conversationId = conversation._id.toString();
    await this.cache.del(`chat:conversations:${userId}`, `chat:conversation:${userId}:${conversationId}`);

    return {
      conversationId,
      reply: agentReply.reply,
      toolsUsed: agentReply.tools_used ?? [],
      suggestions: agentReply.suggestions ?? [],
    };
  }

  private async callAgent(
    userId: string,
    userJwt: string,
    conversationId: string,
    message: string,
    agentId?: string,
  ): Promise<AgentReply> {
    try {
      const response = await firstValueFrom(
        this.http.post<AgentReply>(
          `${this.agentUrl}/chat`,
          { user_id: userId, conversation_id: conversationId, message, agent_id: agentId },
          { headers: { Authorization: `Bearer ${userJwt}` } },
        ),
      );
      return response.data;
    } catch (err) {
      this.logger.error(`python-agent call failed: ${(err as Error).message}`);
      const userMessage = extractAgentErrorMessage(err);
      return {
        reply: userMessage ?? "I couldn't reach the AI agent service. Please try again shortly.",
        tools_used: [],
      };
    }
  }

  /** Calls python-agent's /chat/stream (Server-Sent Events) and relays each
   * delta/progress frame to onEvent as it arrives, resolving with the
   * terminal "done" frame's reply/tools_used — same external contract as
   * callAgent(), just fed incrementally instead of all at once. */
  private async callAgentStreaming(
    userId: string,
    userJwt: string,
    conversationId: string,
    message: string,
    onEvent: (event: StreamEvent) => void,
    agentId?: string,
  ): Promise<AgentReply> {
    try {
      const response = await firstValueFrom(
        this.http.post(
          `${this.agentUrl}/chat/stream`,
          { user_id: userId, conversation_id: conversationId, message, agent_id: agentId },
          { headers: { Authorization: `Bearer ${userJwt}` }, responseType: 'stream' },
        ),
      );

      return await new Promise<AgentReply>((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const stream = response.data as NodeJS.ReadableStream;

        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame.startsWith('data: ')) continue;

            // Was previously unguarded: a JSON.parse throw here happens
            // inside this 'data' event-listener callback, outside the
            // try/catch below (that one only wraps the initial POST + this
            // Promise executor's synchronous setup, not code running later
            // inside a callback it registered) — an uncaught throw here
            // would surface as an unhandled request error instead of
            // degrading gracefully. Skipping just this one malformed frame
            // and continuing is safe: every frame is self-contained (see
            // the SSE framing above), so losing one doesn't corrupt the
            // ones before/after it, and a truly fatal stream problem still
            // surfaces via the 'error'/'end' handlers below.
            let event;
            try {
              event = JSON.parse(frame.slice(6));
            } catch (parseErr) {
              this.logger.warn(`Skipping malformed SSE frame: ${(parseErr as Error).message}`);
              continue;
            }
            if (
              event.type === 'delta' ||
              event.type === 'progress' ||
              event.type === 'reasoning' ||
              event.type === 'plan' ||
              event.type === 'agent_done' ||
              event.type === 'reflecting'
            ) {
              onEvent(event);
            } else if (event.type === 'done') {
              settled = true;
              resolve({ reply: event.reply, tools_used: event.tools_used, suggestions: event.suggestions });
            } else if (event.type === 'error' || event.type === 'billing_error') {
              // event.message is already a clean, user-safe string here (a
              // billing_error's is the same INSUFFICIENT_BALANCE message the
              // non-streaming path gets via HTTP detail — see routes/chat.py)
              // — wrapped so the outer catch below can tell it apart from a
              // raw network/timeout Error and show it as-is.
              settled = true;
              reject(new AgentUserFacingError(event.message));
            }
          }
        });
        stream.on('end', () => {
          if (!settled) reject(new Error('Agent stream ended without a final result'));
        });
        stream.on('error', (err) => {
          if (!settled) reject(err);
        });
      });
    } catch (err) {
      this.logger.error(`python-agent streaming call failed: ${(err as Error).message}`);
      const userMessage = extractAgentErrorMessage(err);
      return {
        reply: userMessage ?? "I couldn't reach the AI agent service. Please try again shortly.",
        tools_used: [],
      };
    }
  }

  /** Relays a "stop generating" request to python-agent's cancellation
   * registry (app.agent.cancellation) for this conversation's in-flight
   * stream, if any. Best-effort: logs and swallows failures rather than
   * throwing — a failed cancel must never crash the socket handler that
   * called it (ChatGateway's 'cancel' handler), since the user already
   * sees generation stop client-side regardless. */
  async cancelAgent(conversationId: string, userJwt: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(
          `${this.agentUrl}/chat/stream/cancel`,
          { conversation_id: conversationId },
          { headers: { Authorization: `Bearer ${userJwt}` } },
        ),
      );
    } catch (err) {
      this.logger.warn(`Cancel request to python-agent failed: ${(err as Error).message}`);
    }
  }
}
