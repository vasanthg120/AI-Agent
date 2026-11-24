import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AiConversationSettings, METRICS, SettingsSource, cleanSettings, defaultSettings, isTimeZone } from './conversation-settings';
import { UpdateConversationSettingsDto } from './dto/update-conversation-settings.dto';

const SETTINGS = 'ai_conversation_settings';

export interface ConversationSettingsView {
  // What Haive does for this person now.
  settings: AiConversationSettings;
  // Where that comes from: their own settings, the company default, or Haive's own defaults.
  source: SettingsSource;
  // The company default (null until an owner or admin saves one).
  organization: AiConversationSettings | null;
  organizationUpdatedAt: Date | null;
  canSetOrganization: boolean;
  defaults: AiConversationSettings;
}

const isAdmin = (caller: JwtPayload) => caller.roles.some((r) => r === 'owner' || r === 'admin');

// AI Conversations settings: one document per person (in each business they
// work in) and one company default per business. A person's own settings win;
// without them the company default applies; without that, Haive's defaults.
@Injectable()
export class ConversationSettingsService implements OnModuleInit {
  private readonly logger = new Logger(ConversationSettingsService.name);

  constructor(@InjectConnection() private connection: Connection) {}

  private get col() {
    return this.connection.collection(SETTINGS);
  }

  async onModuleInit(): Promise<void> {
    await this.col
      .createIndex({ kind: 1, organizationId: 1, userId: 1 }, { unique: true, name: 'one_per_person_and_company' })
      .catch((err: Error) => this.logger.warn(`${SETTINGS} index: ${err.message}`));
  }

  /** What applies to this person right now. */
  async resolve(caller: Pick<JwtPayload, 'sub' | 'organizationId'>): Promise<{ settings: AiConversationSettings; source: SettingsSource }> {
    const docs = await this.col
      .find({ organizationId: caller.organizationId, $or: [{ kind: 'user', userId: caller.sub }, { kind: 'organization', userId: null }] })
      .toArray();
    const mine = docs.find((d) => d.kind === 'user');
    const org = docs.find((d) => d.kind === 'organization');
    const orgSettings = org ? cleanSettings(org.settings) : null;
    if (mine) return { settings: cleanSettings(mine.settings, orgSettings ?? defaultSettings()), source: 'mine' };
    if (orgSettings) return { settings: orgSettings, source: 'organization' };
    return { settings: defaultSettings(), source: 'default' };
  }

  /** Every saved setting, for the proactive run: company defaults by business, people's own by "business|person". */
  async loadAll(): Promise<{ organization: Map<string, AiConversationSettings>; people: Map<string, AiConversationSettings> }> {
    const docs = await this.col.find({}).toArray();
    const organization = new Map<string, AiConversationSettings>();
    for (const d of docs) if (d.kind === 'organization') organization.set(String(d.organizationId), cleanSettings(d.settings));
    const people = new Map<string, AiConversationSettings>();
    for (const d of docs) {
      if (d.kind !== 'user') continue;
      const base = organization.get(String(d.organizationId)) ?? defaultSettings();
      people.set(`${d.organizationId}|${d.userId}`, cleanSettings(d.settings, base));
    }
    return { organization, people };
  }

  async view(caller: JwtPayload): Promise<ConversationSettingsView> {
    const [resolved, org] = await Promise.all([this.resolve(caller), this.col.findOne({ kind: 'organization', organizationId: caller.organizationId, userId: null })]);
    return {
      ...resolved,
      organization: org ? cleanSettings(org.settings) : null,
      organizationUpdatedAt: (org?.updatedAt as Date | undefined) ?? null,
      canSetOrganization: isAdmin(caller),
      defaults: defaultSettings(),
    };
  }

  /** Saves this person's own settings: what they change, on top of what applies to them now. */
  async updateMine(caller: JwtPayload, dto: UpdateConversationSettingsDto, now = new Date()): Promise<ConversationSettingsView> {
    const { settings } = await this.resolve(caller);
    const next = this.apply(settings, dto);
    await this.col.updateOne(
      { kind: 'user', organizationId: caller.organizationId, userId: caller.sub },
      { $set: { settings: next, updatedAt: now }, $setOnInsert: { kind: 'user', organizationId: caller.organizationId, userId: caller.sub, createdAt: now } },
      { upsert: true },
    );
    return this.view(caller);
  }

  /** Back to the company default (or Haive's own). */
  async resetMine(caller: JwtPayload): Promise<ConversationSettingsView> {
    await this.col.deleteOne({ kind: 'user', organizationId: caller.organizationId, userId: caller.sub });
    return this.view(caller);
  }

  /** The company default — owners and admins (the route checks the role). */
  async updateOrganization(caller: JwtPayload, dto: UpdateConversationSettingsDto, now = new Date()): Promise<ConversationSettingsView> {
    const current = await this.col.findOne({ kind: 'organization', organizationId: caller.organizationId, userId: null });
    const next = this.apply(current ? cleanSettings(current.settings) : defaultSettings(), dto);
    await this.col.updateOne(
      { kind: 'organization', organizationId: caller.organizationId, userId: null },
      { $set: { settings: next, updatedAt: now, updatedBy: caller.sub }, $setOnInsert: { kind: 'organization', organizationId: caller.organizationId, userId: null, createdAt: now } },
      { upsert: true },
    );
    return this.view(caller);
  }

  private apply(current: AiConversationSettings, dto: UpdateConversationSettingsDto): AiConversationSettings {
    if (dto.timeZone && !isTimeZone(dto.timeZone)) throw new BadRequestException('That time zone isn’t recognised.');
    const metrics = dto.metrics ? { ...current.metrics, ...Object.fromEntries(METRICS.filter((m) => dto.metrics![m] !== undefined).map((m) => [m, dto.metrics![m]])) } : current.metrics;
    // Only what was sent changes; cleanSettings then makes the whole thing safe and tidy.
    const sent = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    return cleanSettings({ ...current, ...sent, metrics } as Partial<AiConversationSettings>, current);
  }
}
