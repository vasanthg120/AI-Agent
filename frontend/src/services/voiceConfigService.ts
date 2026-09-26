import { axiosClient } from '@/api/axiosClient';
import { readBlobErrorBody } from '@/utils/errors';

// The normalized voice model the backend exposes (see
// backend/src/voice/catalog/voice-catalog.ts VoiceDto): an accent, a gender, a
// personality. Nothing here is provider-specific — which engine speaks a voice
// is the backend's business, and this file never sees a provider voice name,
// key or parameter.

export type VoiceAccent = 'indian' | 'australian' | 'american' | 'british';
export type VoiceGender = 'female' | 'male';
export type VoicePersonality =
  'professional' | 'friendly' | 'conversational' | 'confident' | 'empathetic' | 'energetic' | 'calm';
// Where the active voice / personality comes from.
export type VoiceSource = 'user' | 'organization' | 'system';
export type PersonalitySource = 'user' | 'organization' | 'voice';

export interface VoiceOption {
  voiceId: string;
  displayName: string;
  accent: VoiceAccent;
  accentLabel: string;
  gender: VoiceGender;
  language: string;
  // The voice's own default speaking style.
  personality: VoicePersonality;
  description: string;
  // Display label of the engine behind it (e.g. "Sarvam AI") — for status
  // messages only.
  provider: string;
  // False when the voice can't be spoken right now; `unavailableReason` says why.
  isActive: boolean;
  unavailableReason: string | null;
  // The organization's default voice.
  isDefault: boolean;
  // This person's own selection (only while their organization allows one).
  isSelected: boolean;
}

export interface VoiceFallbackInfo {
  requestedVoiceId: string;
  requestedDisplayName: string;
  requestedFrom: 'user' | 'organization';
  reason: string;
}

export interface PersonalityOption {
  id: VoicePersonality;
  label: string;
  hint: string;
}

export interface VoiceConfig {
  voices: VoiceOption[];
  personalities: PersonalityOption[];
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
  // The voice that actually speaks for this person right now.
  active: {
    voiceId: string;
    personality: VoicePersonality;
    source: VoiceSource;
    personalitySource: PersonalitySource;
    fallback: VoiceFallbackInfo | null;
  };
  canConfigureOrganization: boolean;
  canChooseOwnVoice: boolean;
  voiceAccessEnabled: boolean;
  // False when the backend couldn't check which voices are available — every
  // voice then shows as usable and the page says so.
  availabilityChecked: boolean;
}

// `null` clears a value back to "not set"; leaving a key out leaves it alone.
export interface OrganizationVoicePatch {
  defaultVoiceId?: string | null;
  defaultPersonality?: VoicePersonality | null;
  allowUserOverride?: boolean;
}

export interface MyVoicePatch {
  voiceId?: string | null;
  personality?: VoicePersonality | null;
}

export const VOICE_ACCENT_ORDER: VoiceAccent[] = ['indian', 'australian', 'american', 'british'];

export const voiceConfigService = {
  async getConfig(): Promise<VoiceConfig> {
    const { data } = await axiosClient.get<VoiceConfig>('/voice/config');
    return data;
  },

  // Owner/admin only (the backend enforces it) — the organization's defaults.
  async updateOrganization(patch: OrganizationVoicePatch): Promise<VoiceConfig> {
    const { data } = await axiosClient.put<VoiceConfig>('/voice/config/organization', patch);
    return data;
  },

  // This person's own choice — refused by the backend when the organization
  // has turned personal selection off.
  async updateMine(patch: MyVoicePatch): Promise<VoiceConfig> {
    const { data } = await axiosClient.put<VoiceConfig>('/voice/config/me', patch);
    return data;
  },

  // A short sample of one voice. Served from a server-side cache after the
  // first play, so trying voices back to back is cheap.
  async preview(voiceId: string, personality?: VoicePersonality | null): Promise<Blob> {
    try {
      const { data } = await axiosClient.post(
        `/voice/config/voices/${encodeURIComponent(voiceId)}/preview`,
        personality ? { personality } : {},
        { responseType: 'blob' },
      );
      return data as Blob;
    } catch (err) {
      throw await readBlobErrorBody(err);
    }
  },
};
