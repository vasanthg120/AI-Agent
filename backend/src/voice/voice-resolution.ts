import { OrganizationVoiceSettings } from '../organizations/schemas/organization.schema';
import { UserVoicePreferences } from '../users/schemas/user.schema';
import {
  CatalogVoice,
  SYSTEM_DEFAULT_VOICE_ID,
  VoicePersonality,
  getCatalogVoice,
  isVoicePersonality,
} from './catalog/voice-catalog';
import { VoiceAvailabilityResult } from './voice.service';

// Pure on purpose (no Nest, no I/O): this is the single rule for "which voice
// speaks for this person", so it is unit-tested directly. VoiceConfigService
// supplies the inputs; nothing else in the app decides a voice.

export type VoiceSource = 'user' | 'organization' | 'system';
export type PersonalitySource = 'user' | 'organization' | 'voice';
export type AvailabilityMap = Record<string, VoiceAvailabilityResult>;

export interface VoiceFallback {
  requestedVoiceId: string;
  requestedDisplayName: string;
  requestedFrom: 'user' | 'organization';
  reason: string;
}

export interface ResolvedVoice {
  voice: CatalogVoice;
  personality: VoicePersonality;
  source: VoiceSource;
  personalitySource: PersonalitySource;
  // Set when a higher-priority choice was skipped because it can't be spoken.
  fallback: VoiceFallback | null;
}

/** null when the voice is usable. `availability` null = the check itself
 * failed — treated as usable (fail open), so a hiccup in the check can't take
 * speech away from everyone; a real failure then surfaces on the speak call. */
export function unavailableReason(status: VoiceAvailabilityResult | undefined): string | null {
  return status && !status.available ? status.reason ?? 'This voice is unavailable right now.' : null;
}

export function resolveVoice(
  org: OrganizationVoiceSettings,
  user: UserVoicePreferences,
  availability: AvailabilityMap | null,
): ResolvedVoice {
  const allowOverride = org.allowUserOverride !== false;

  // Precedence: the person's own choice (only while the organization allows
  // it) -> the organization's default -> the system default.
  const candidates: { voiceId: string; source: VoiceSource }[] = [];
  if (allowOverride && user.voiceId) candidates.push({ voiceId: user.voiceId, source: 'user' });
  if (org.defaultVoiceId) candidates.push({ voiceId: org.defaultVoiceId, source: 'organization' });
  candidates.push({ voiceId: SYSTEM_DEFAULT_VOICE_ID, source: 'system' });

  let fallback: VoiceFallback | null = null;
  let chosen: { voice: CatalogVoice; source: VoiceSource } | null = null;
  for (const candidate of candidates) {
    const voice = getCatalogVoice(candidate.voiceId);
    const reason = voice ? unavailableReason(availability?.[voice.voiceId]) : 'This voice is no longer offered.';
    if (voice && !reason) {
      chosen = { voice, source: candidate.source };
      break;
    }
    if (!fallback && candidate.source !== 'system') {
      fallback = {
        requestedVoiceId: candidate.voiceId,
        requestedDisplayName: voice?.displayName ?? candidate.voiceId,
        requestedFrom: candidate.source,
        reason: reason!,
      };
    }
  }
  // Even the system default can be down (its provider not connected). Speak
  // with it anyway so the failure is the provider's own clear message, rather
  // than silently switching to a voice nobody chose.
  chosen ??= { voice: getCatalogVoice(SYSTEM_DEFAULT_VOICE_ID)!, source: 'system' };

  // Personality is a separate, optional override at the same two levels; it
  // falls back to the voice's own style.
  const userPersonality = allowOverride && isVoicePersonality(user.personality) ? user.personality : undefined;
  const orgPersonality = isVoicePersonality(org.defaultPersonality) ? org.defaultPersonality : undefined;
  const personality = userPersonality ?? orgPersonality ?? chosen.voice.defaultPersonality;
  const personalitySource: PersonalitySource = userPersonality ? 'user' : orgPersonality ? 'organization' : 'voice';

  return { voice: chosen.voice, personality, source: chosen.source, personalitySource, fallback };
}
