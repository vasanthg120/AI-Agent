import { createHash, randomUUID } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ReservationService } from '../billing/reservation.service';
import { ChatService } from '../chat/chat.service';
import { TeamActivityService } from '../team-activity/team-activity.service';
import { ActionView, StoredAction, actionView, cleanActions, dueDateFor } from './briefing-actions';
import { BriefingFacts, BriefingFactsService } from './briefing-facts.service';
import { AiConversationSettings, SpeakingStyle } from './conversation-settings';
import { ConversationSettingsService } from './conversation-settings.service';
import { ProactiveService } from './proactive.service';

const BRIEFINGS = 'ai_briefings';
// The same facts within this long reuse the briefing already written (no second charge for a page reload).
const REUSE_FOR_MS = 20 * 60 * 1000;

/** What the AI wrote (python-agent app/agent/briefing.py). */
export interface Briefing {
  spoken: string;
  headline: string;
  points: { text: string; kind: 'actual' | 'estimate' | 'forecast' | 'recommendation'; severity: 'critical' | 'warning' | 'good' | 'info'; business: string }[];
  nextAction: { text: string; why: string } | null;
  suggestedQuestions: string[];
  // What Haive offers to do — done only on the person's yes (see briefing-actions.ts).
  actions?: StoredAction[];
}

export interface BriefingView {
  id: string;
  date: string;
  slot: string;
  // A briefing Haive reached out with: the schedule's name ("Morning briefing") or "Alert · T.Nagar". Null: today's sign-in briefing.
  label: string | null;
  // What the AI wrote; its suggestions as the person sees them (who they stand for stays on the server).
  briefing: Omit<Briefing, 'actions'> & { actions: ActionView[] };
  // The chat conversation the briefing opens: follow-up questions continue it (the agent sees the briefing).
  conversationId: string;
  generatedAt: Date;
  // Spoken aloud on its own now? By the person's greeting setting: the first sign-in of
  // the day (the default), every sign-in, or never (only when tapped) — and never with voice off.
  shouldSpeak: boolean;
  spokenAt?: Date;
}

/** A stable fingerprint of the facts (not the time of day) and of how it's said, to tell whether anything changed. */
export function factsHash(facts: BriefingFacts, style: SpeakingStyle = 'concise'): string {
  const { now, ...rest } = facts;
  return createHash('sha1').update(JSON.stringify({ ...rest, date: now.date, style })).digest('hex');
}

/** The settings a briefing is written from: changing any of them writes it again. */
export function settingsKeyOf(settings: AiConversationSettings): string {
  const { language, style, metrics, questions } = settings;
  return createHash('sha1').update(JSON.stringify({ language, style, metrics, questions: questions.filter((q) => q.enabled).map((q) => q.text) })).digest('hex');
}

/** Whether the briefing should speak on its own for this sign-in. */
export function shouldSpeakFor(doc: { spokenAt?: Date | null; spokenSessions?: string[] }, settings: Pick<AiConversationSettings, 'voiceEnabled' | 'greeting'>, sessionId?: string): boolean {
  if (!settings.voiceEnabled || settings.greeting === 'tap') return false;
  // Every sign-in: not yet heard in this session (a token without a session falls back to once a day).
  if (settings.greeting === 'every_login' && sessionId) return !(doc.spokenSessions ?? []).includes(sessionId);
  return !doc.spokenAt;
}

// Haive's voice assistant: the spoken business briefing. Written by the AI from
// facts the backend gathers (BriefingFactsService) — never from hard-coded
// figures — once per person per day (and slot), reused while the facts are the
// same, and billed like every other AI action (reserve, settle, release). The
// briefing opens a real chat conversation, so the person's follow-up questions
// go to the normal AI agent with the briefing as context.
@Injectable()
export class AssistantService implements OnModuleInit {
  private readonly logger = new Logger(AssistantService.name);
  private readonly pythonAgentUrl: string;
  // Two tabs opening at once write one briefing, not two.
  private readonly inFlight = new Map<string, Promise<BriefingView>>();

  constructor(
    @InjectConnection() private connection: Connection,
    private facts: BriefingFactsService,
    private settings: ConversationSettingsService,
    private proactive: ProactiveService,
    private reservations: ReservationService,
    private chat: ChatService,
    private activity: TeamActivityService,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private get col() {
    return this.connection.collection(BRIEFINGS);
  }

  async onModuleInit(): Promise<void> {
    await this.col
      .createIndex({ userId: 1, organizationId: 1, date: 1, slot: 1 }, { unique: true, name: 'one_per_person_day_slot' })
      .catch((err: Error) => this.logger.warn(`${BRIEFINGS} index: ${err.message}`));
  }

  async briefing(caller: JwtPayload, options: { slot?: string; refresh?: boolean } = {}, now = new Date()): Promise<BriefingView> {
    if (caller.aiAccessEnabled === false) throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    let slot = options.slot || 'login';
    // Opened from a reach-out (a scheduled briefing or an alert): written now, leading with why Haive reached out.
    // A slot nothing was sent for is just today's briefing (made-up slots don't each cost a briefing).
    const reachOut = slot === 'login' ? null : await this.proactive.eventForSlot(caller, slot, now);
    if (!reachOut) slot = 'login';
    // The person's AI Conversations settings: language, the questions they care about, what they follow, how much to say.
    const { settings } = await this.settings.resolve(caller);
    const facts = await this.facts.build(
      caller,
      { language: settings.language, questions: settings.questions.filter((q) => q.enabled).map((q) => q.text), metrics: settings.metrics },
      now,
    );
    if (reachOut?.focus) facts.focus = reachOut.focus;
    const key = { userId: caller.sub, organizationId: caller.organizationId, date: facts.now.date, slot };
    const hash = factsHash(facts, settings.style);
    const saved = await this.col.findOne(key);
    const recent = saved && now.getTime() - new Date(saved.generatedAt).getTime() < REUSE_FOR_MS;
    // Reused while nothing changed (or for a short while) — unless the person changed how it should be written.
    const settingsChanged = !!saved?.settingsKey && saved.settingsKey !== settingsKeyOf(settings);
    if (saved && !options.refresh && !settingsChanged && (saved.factsHash === hash || recent)) return this.view(saved, settings, caller.jti);

    // Only a briefing being written from the same settings is shared (a change of language mid-write gets its own).
    const flightKey = `${key.userId}|${key.organizationId}|${key.date}|${slot}|${settingsKeyOf(settings)}`;
    const running = this.inFlight.get(flightKey);
    if (running) return running;
    const work = this.write(caller, facts, settings, key, hash, reachOut?.label || null, now).finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, work);
    return work;
  }

  private async write(
    caller: JwtPayload,
    facts: BriefingFacts,
    settings: AiConversationSettings,
    key: { userId: string; organizationId: string; date: string; slot: string },
    hash: string,
    label: string | null,
    now: Date,
  ): Promise<BriefingView> {
    const requestId = randomUUID();
    await this.reservations.reserve(this.reservations.resolveTenantKey(caller.organizationId, caller.sub), caller.sub, requestId, 'assistant-briefing');
    let briefing: Briefing;
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId: caller.organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<Briefing>(
          `${this.pythonAgentUrl}/assistant/briefing`,
          // What the refs stand for stays here.
          { facts: { ...facts, actionTargets: undefined }, style: settings.style, request_id: requestId },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 60_000 },
        ),
      );
      await this.reservations.settle(requestId);
      briefing = { ...data, actions: cleanActions((data as { actions?: unknown }).actions, facts.actionTargets) };
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`Briefing failed for ${caller.sub}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Haive couldn’t prepare your briefing right now. Please try again in a minute.');
    }
    // The briefing is the first message of a real conversation, so a follow-up question has it as context.
    const conversation = await this.chat.createSystemConversationRecord(
      caller.sub,
      caller.organizationId,
      undefined,
      `${label ?? 'Haive briefing'} · ${facts.now.weekday} ${facts.now.date}`,
      'Brief me on my business.',
      briefing.spoken,
    );
    const conversationId = String((conversation as { conversationId?: string }).conversationId ?? '');
    // Written again later today, it keeps when it was heard (it isn't a new greeting).
    await this.col.updateOne(
      key,
      { $set: { ...key, label, briefing, conversationId, factsHash: hash, settingsKey: settingsKeyOf(settings), generatedAt: now } },
      { upsert: true },
    );
    const saved = await this.col.findOne(key);
    return this.view(saved!, settings, caller.jti);
  }

  /** The briefing was spoken (or shown) — by the greeting setting, it won't speak on its own again today / this sign-in. */
  async markSpoken(caller: JwtPayload, id: string, now = new Date()): Promise<void> {
    if (!isValidObjectId(id)) throw new NotFoundException('Briefing not found.');
    const result = await this.col.updateOne(
      { _id: new Types.ObjectId(id), userId: caller.sub, organizationId: caller.organizationId },
      { $set: { spokenAt: now }, ...(caller.jti ? { $addToSet: { spokenSessions: caller.jti } } : {}) },
    );
    if (result.matchedCount === 0) throw new NotFoundException('Briefing not found.');
  }

  /**
   * Does what Haive suggested — on the person's yes. Reads what to do from the stored
   * briefing (never from the browser), claims it so a double tap can't do it twice, and
   * reports "done" only when it really was; on failure it can be tried again.
   */
  async runAction(caller: JwtPayload, id: string, actionId: string, now = new Date()): Promise<ActionView> {
    const doc = await this.ownBriefing(caller, id);
    const action = ((doc.briefing?.actions ?? []) as StoredAction[]).find((a) => a.id === actionId);
    if (!action) throw new NotFoundException('That suggestion isn’t here any more.');
    if (action.status === 'done') return actionView(action);
    const claim = await this.col.updateOne(
      { _id: doc._id, 'briefing.actions': { $elemMatch: { id: actionId, status: { $in: ['suggested', 'dismissed'] } } } },
      { $set: { 'briefing.actions.$.status': 'running' }, $unset: { 'briefing.actions.$.error': '' } },
    );
    if (claim.modifiedCount === 0) throw new ConflictException('Haive is already doing that.');
    const set = (fields: Partial<StoredAction>) =>
      this.col.updateOne({ _id: doc._id, 'briefing.actions.id': actionId }, { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`briefing.actions.$.${k}`, v])) });
    try {
      const task = await this.activity.giveTask(
        caller,
        { organizationId: action.businessId, assigneeId: action.personId, title: action.title, dueDate: dueDateFor(action.due, action.timeZone, now).toISOString(), note: 'Suggested by Haive in your briefing.' },
        now,
      );
      const result = action.personRef === 'me' ? `Added to your tasks — due ${action.due}.` : `Task given to ${task.personName} — due ${action.due}.`;
      await set({ status: 'done', result, taskId: task.id });
      return actionView({ ...action, status: 'done', result });
    } catch (err) {
      const message = err instanceof HttpException ? err.message : 'Haive couldn’t do that just now. Please try again.';
      await set({ status: 'suggested', error: message });
      this.logger.warn(`Briefing action ${actionId} for ${caller.sub} failed: ${(err as Error).message}`);
      throw err instanceof HttpException ? err : new ServiceUnavailableException(message);
    }
  }

  /** "Not now": the suggestion is put aside (it can still be done later). */
  async dismissAction(caller: JwtPayload, id: string, actionId: string): Promise<ActionView> {
    const doc = await this.ownBriefing(caller, id);
    const action = ((doc.briefing?.actions ?? []) as StoredAction[]).find((a) => a.id === actionId);
    if (!action) throw new NotFoundException('That suggestion isn’t here any more.');
    if (action.status !== 'suggested') return actionView(action);
    await this.col.updateOne({ _id: doc._id, 'briefing.actions.id': actionId }, { $set: { 'briefing.actions.$.status': 'dismissed' } });
    return actionView({ ...action, status: 'dismissed' });
  }

  private async ownBriefing(caller: JwtPayload, id: string): Promise<Record<string, any>> {
    if (!isValidObjectId(id)) throw new NotFoundException('Briefing not found.');
    const doc = await this.col.findOne({ _id: new Types.ObjectId(id), userId: caller.sub, organizationId: caller.organizationId });
    if (!doc) throw new NotFoundException('Briefing not found.');
    return doc;
  }

  private view(doc: Record<string, any>, settings: AiConversationSettings, sessionId?: string): BriefingView {
    return {
      id: doc._id.toString(),
      date: doc.date,
      slot: doc.slot,
      label: doc.label ?? null,
      briefing: { ...doc.briefing, actions: ((doc.briefing?.actions ?? []) as StoredAction[]).map(actionView) },
      conversationId: doc.conversationId,
      generatedAt: doc.generatedAt,
      // One they opened from a notification speaks (voice on) until heard; the sign-in briefing follows the greeting rule.
      shouldSpeak: doc.slot !== 'login' ? settings.voiceEnabled && !doc.spokenAt : shouldSpeakFor(doc, settings, sessionId),
      spokenAt: doc.spokenAt,
    };
  }
}
