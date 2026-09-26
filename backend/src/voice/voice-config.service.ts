import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { OrganizationsService } from '../organizations/organizations.service';
import { OrganizationVoiceSettings } from '../organizations/schemas/organization.schema';
import { UserVoicePreferences } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import {
  SYSTEM_DEFAULT_VOICE_ID,
  VOICE_CATALOG,
  VOICE_PERSONALITY_INFO,
  VOICE_SAMPLE_TEXT,
  VoiceDto,
  VoicePersonality,
  getCatalogVoice,
  toVoiceDto,
} from './catalog/voice-catalog';
import { UpdateVoiceOrganizationDto, UpdateVoicePreferenceDto } from './dto/update-voice-settings.dto';
import {
  AvailabilityMap,
  PersonalitySource,
  ResolvedVoice,
  VoiceFallback,
  VoiceSource,
  resolveVoice,
  unavailableReason,
} from './voice-resolution';
import { VoiceService } from './voice.service';

// Voice availability is a platform-wide fact (provider keys are platform-wide),
// so one shared cache serves every organization. A minute is short enough that
// connecting a provider or fixing a key shows up quickly; a failed check is
// remembered only briefly so a provider outage doesn't make every page load
// wait on a fresh timeout.
const AVAILABILITY_TTL_MS = 60_000;
const FAILED_CHECK_TTL_MS = 15_000;

export interface VoiceConfigDto {
  voices: VoiceDto[];
  personalities: { id: VoicePersonality; label: string; hint: string }[];
  sampleText: string;
  systemDefaultVoiceId: string;
  organization: {
    defaultVoiceId: string | null;
    defaultPersonality: VoicePersonality | null;
    allowUserOverride: boolean;
    updatedAt: string | null;
    updatedByName: string | null;
  };
  user: { voiceId: string | null; personality: VoicePersonality | null };
  active: {
    voiceId: string;
    personality: VoicePersonality;
    source: VoiceSource;
    personalitySource: PersonalitySource;
    fallback: VoiceFallback | null;
  };
  canConfigureOrganization: boolean;
  canChooseOwnVoice: boolean;
  voiceAccessEnabled: boolean;
  // False when the availability check itself failed — every voice is then shown
  // as usable and the page says so, rather than pretending it knows.
  availabilityChecked: boolean;
}

// One place that decides which voice speaks (resolve) and owns the settings
// that feed it. Voice & Accent is deliberately one configuration for all
// speech — chat voice replies, the Call Copilot AI Coach, anything added later
// — never a setting per feature.
@Injectable()
export class VoiceConfigService {
  private readonly logger = new Logger(VoiceConfigService.name);
  private availabilityCache: { at: number; byVoice: AvailabilityMap | null } | null = null;
  private availabilityInflight: Promise<AvailabilityMap | null> | null = null;

  constructor(
    private organizations: OrganizationsService,
    private users: UsersService,
    private audit: AuditService,
    private voiceService: VoiceService,
  ) {}

  /** Which voices can be spoken right now, or null when that couldn't be
   * determined (callers fail open — see unavailableReason). */
  getAvailability(): Promise<AvailabilityMap | null> {
    const cached = this.availabilityCache;
    if (cached && Date.now() - cached.at < (cached.byVoice ? AVAILABILITY_TTL_MS : FAILED_CHECK_TTL_MS)) {
      return Promise.resolve(cached.byVoice);
    }
    // Concurrent callers (a page load fans out several requests) share one check.
    this.availabilityInflight ??= this.refreshAvailability().finally(() => {
      this.availabilityInflight = null;
    });
    return this.availabilityInflight;
  }

  private async refreshAvailability(): Promise<AvailabilityMap | null> {
    try {
      const byVoice = await this.voiceService.checkAvailability(
        VOICE_CATALOG.map((v) => ({ voiceId: v.voiceId, provider: v.provider, voiceRef: v.providerRef })),
      );
      this.availabilityCache = { at: Date.now(), byVoice };
      return byVoice;
    } catch (err) {
      this.logger.warn(`Voice availability check failed: ${(err as Error).message}`);
      this.availabilityCache = { at: Date.now(), byVoice: null };
      return null;
    }
  }

  /** The voice that speaks for this person right now. */
  async resolve(organizationId: string, userId: string): Promise<ResolvedVoice> {
    const [org, prefs, availability] = await Promise.all([
      this.organizations.getVoiceSettings(organizationId),
      this.users.getVoicePreferences(userId),
      this.getAvailability(),
    ]);
    return resolveVoice(org, prefs, availability);
  }

  /** Everything the Voice & Accent page needs, in one call. */
  async getConfig(user: JwtPayload): Promise<VoiceConfigDto> {
    const [org, prefs, availability] = await Promise.all([
      this.organizations.getVoiceSettings(user.organizationId),
      this.users.getVoicePreferences(user.sub),
      this.getAvailability(),
    ]);
    const resolved = resolveVoice(org, prefs, availability);
    const allowOverride = org.allowUserOverride !== false;
    const updatedBy = org.updatedBy ? await this.users.findById(org.updatedBy) : null;

    return {
      voices: VOICE_CATALOG.map((voice) => {
        const reason = unavailableReason(availability?.[voice.voiceId]);
        return toVoiceDto(voice, {
          isActive: reason === null,
          unavailableReason: reason,
          isDefault: org.defaultVoiceId === voice.voiceId,
          isSelected: allowOverride && prefs.voiceId === voice.voiceId,
        });
      }),
      personalities: VOICE_PERSONALITY_INFO,
      sampleText: VOICE_SAMPLE_TEXT,
      systemDefaultVoiceId: SYSTEM_DEFAULT_VOICE_ID,
      organization: {
        defaultVoiceId: getCatalogVoice(org.defaultVoiceId) ? org.defaultVoiceId! : null,
        defaultPersonality: snapshotPersonality(org.defaultPersonality),
        allowUserOverride: allowOverride,
        updatedAt: org.updatedAt ? new Date(org.updatedAt).toISOString() : null,
        updatedByName: updatedBy?.name ?? null,
      },
      user: {
        voiceId: getCatalogVoice(prefs.voiceId) ? prefs.voiceId! : null,
        personality: snapshotPersonality(prefs.personality),
      },
      active: {
        voiceId: resolved.voice.voiceId,
        personality: resolved.personality,
        source: resolved.source,
        personalitySource: resolved.personalitySource,
        fallback: resolved.fallback,
      },
      canConfigureOrganization: user.roles.some((role) => role === 'owner' || role === 'admin'),
      canChooseOwnVoice: allowOverride,
      voiceAccessEnabled: user.voiceAccessEnabled !== false,
      availabilityChecked: availability !== null,
    };
  }

  async updateOrganization(user: JwtPayload, dto: UpdateVoiceOrganizationDto, ip?: string): Promise<VoiceConfigDto> {
    if (dto.defaultVoiceId === undefined && dto.defaultPersonality === undefined && dto.allowUserOverride === undefined) {
      return this.getConfig(user);
    }
    if (dto.defaultVoiceId) this.assertSelectable(dto.defaultVoiceId, await this.getAvailability());

    const before = await this.organizations.getVoiceSettings(user.organizationId);
    const after = await this.organizations.updateVoiceSettings(user.organizationId, dto, user.sub);
    this.recordChange(user, ip, 'voice.organization_settings.updated', '/voice/config/organization', snapshotOrg(before), snapshotOrg(after));
    return this.getConfig(user);
  }

  async updateMyPreference(user: JwtPayload, dto: UpdateVoicePreferenceDto, ip?: string): Promise<VoiceConfigDto> {
    const org = await this.organizations.getVoiceSettings(user.organizationId);
    if (org.allowUserOverride === false) {
      throw new ForbiddenException('Your organization has turned off personal voice selection.');
    }
    if (dto.voiceId === undefined && dto.personality === undefined) return this.getConfig(user);
    if (dto.voiceId) this.assertSelectable(dto.voiceId, await this.getAvailability());

    const before = await this.users.getVoicePreferences(user.sub);
    const after = await this.users.updateVoicePreferences(user.sub, dto);
    this.recordChange(user, ip, 'voice.user_preference.updated', '/voice/config/me', snapshotUser(before), snapshotUser(after));
    return this.getConfig(user);
  }

  // Refuses a voice the check has definitively said can't be spoken — picking
  // it would just make everything fall back. When the check itself failed
  // (availability null) the choice is allowed: better a saved preference than a
  // blocked admin during a provider hiccup.
  private assertSelectable(voiceId: string, availability: AvailabilityMap | null): void {
    const voice = getCatalogVoice(voiceId);
    if (!voice) throw new BadRequestException('Unknown voice.');
    const reason = unavailableReason(availability?.[voiceId]);
    if (reason) throw new BadRequestException(`${voice.displayName} can't be selected right now: ${reason}`);
  }

  // Explicit before/after entries, on top of the global interceptor's generic
  // "PUT <route> 200" line — that one can say a settings call happened, only
  // this one says what it changed. Skipped when nothing changed.
  private recordChange(
    user: JwtPayload,
    ip: string | undefined,
    action: string,
    route: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): void {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    void this.audit.log({
      userId: user.sub,
      organizationId: user.organizationId,
      method: 'PUT',
      route,
      statusCode: 200,
      durationMs: 0,
      ip,
      action,
      metadata: { before, after },
    });
  }
}

function snapshotPersonality(value: string | undefined): VoicePersonality | null {
  return VOICE_PERSONALITY_INFO.some((p) => p.id === value) ? (value as VoicePersonality) : null;
}

function snapshotOrg(settings: OrganizationVoiceSettings): Record<string, unknown> {
  return {
    defaultVoiceId: settings.defaultVoiceId ?? null,
    defaultPersonality: settings.defaultPersonality ?? null,
    allowUserOverride: settings.allowUserOverride !== false,
  };
}

function snapshotUser(prefs: UserVoicePreferences): Record<string, unknown> {
  return { voiceId: prefs.voiceId ?? null, personality: prefs.personality ?? null };
}
