import type {
  VoiceAccent,
  VoiceConfig,
  VoiceGender,
  VoiceOption,
  VoicePersonality,
  VoiceSource,
} from '@/services/voiceConfigService';

export const ACCENT_CODE: Record<VoiceAccent, string> = {
  indian: 'IN',
  australian: 'AU',
  american: 'US',
  british: 'GB',
};

export const GENDER_LABEL: Record<VoiceGender, string> = {
  female: 'Female',
  male: 'Male',
};

// Which level of the configuration the active voice comes from — the three
// levels the page keeps visibly distinct (organization default / your
// selection / what is actually in use).
export const SOURCE_LABEL: Record<VoiceSource, string> = {
  user: 'Your selection',
  organization: 'Organization default',
  system: 'System default',
};

export function personalityLabel(config: VoiceConfig, id: VoicePersonality): string {
  return config.personalities.find((p) => p.id === id)?.label ?? id;
}

export function findVoice(config: VoiceConfig, voiceId: string | null): VoiceOption | undefined {
  return voiceId ? config.voices.find((v) => v.voiceId === voiceId) : undefined;
}

export function matchesQuery(voice: VoiceOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [voice.displayName, voice.accentLabel, voice.gender, voice.personality, voice.description]
    .join(' ')
    .toLowerCase()
    .includes(q);
}
