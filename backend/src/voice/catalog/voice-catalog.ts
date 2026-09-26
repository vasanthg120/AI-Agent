// The normalized voice model. Everything outside this file — the API, the
// frontend, the org/user settings — speaks in these terms (an accent, a
// gender, a personality); nothing outside python-agent's TTS adapters ever
// learns a provider's own voice names or parameters. `providerRef` is the one
// provider-private field: it is forwarded to python-agent untouched and is
// never included in anything sent to a browser (see toVoiceDto).
//
// A curated code catalog rather than per-org database rows on purpose: the set
// of voices is a product decision, not tenant data, and organizations only ever
// pick from it (their choice is stored in Organization.voiceSettings).

export const VOICE_ACCENTS = ['indian', 'australian', 'american', 'british'] as const;
export type VoiceAccent = (typeof VOICE_ACCENTS)[number];

export const VOICE_GENDERS = ['female', 'male'] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];

// Same vocabulary python-agent's adapters translate (see
// python-agent/app/integrations/tts/base.py PERSONALITIES) — keep in sync.
export const VOICE_PERSONALITIES = [
  'professional',
  'friendly',
  'conversational',
  'confident',
  'empathetic',
  'energetic',
  'calm',
] as const;
export type VoicePersonality = (typeof VOICE_PERSONALITIES)[number];

export const VOICE_PERSONALITY_INFO: { id: VoicePersonality; label: string; hint: string }[] = [
  { id: 'professional', label: 'Professional', hint: 'Measured and businesslike' },
  { id: 'friendly', label: 'Friendly', hint: 'Warm and approachable' },
  { id: 'conversational', label: 'Conversational', hint: 'Natural, relaxed pacing' },
  { id: 'confident', label: 'Confident', hint: 'Assured and direct' },
  { id: 'empathetic', label: 'Empathetic', hint: 'Gentle and understanding' },
  { id: 'energetic', label: 'Energetic', hint: 'Upbeat and lively' },
  { id: 'calm', label: 'Calm', hint: 'Slow, steady and soothing' },
];

export type VoiceProviderId = 'sarvam' | 'elevenlabs';

export const VOICE_PROVIDER_LABELS: Record<VoiceProviderId, string> = {
  sarvam: 'Sarvam AI',
  elevenlabs: 'ElevenLabs',
};

export const VOICE_ACCENT_LABELS: Record<VoiceAccent, string> = {
  indian: 'Indian English',
  australian: 'Australian English',
  american: 'American English',
  british: 'British English',
};

export interface CatalogVoice {
  voiceId: string;
  displayName: string;
  accent: VoiceAccent;
  gender: VoiceGender;
  // BCP-47 locale this voice speaks English in.
  language: string;
  // The delivery this voice has when nobody has picked a personality.
  defaultPersonality: VoicePersonality;
  description: string;
  provider: VoiceProviderId;
  // Provider-private selector, forwarded to python-agent as `voiceRef`. Sarvam
  // takes a speaker name; ElevenLabs takes {accent, gender, variant}, which
  // python resolves against the connected account's own voice list (see
  // python-agent/app/integrations/tts/elevenlabs.py) rather than hardcoding
  // voice ids that differ per account and get retired.
  providerRef: Record<string, string>;
}

// What speaks when nobody has configured anything: Sarvam's own default
// speaker (shubh), so introducing voice configuration changed nothing audible
// for anyone who never opens it.
export const SYSTEM_DEFAULT_VOICE_ID = 'in-male';

export const VOICE_SAMPLE_TEXT = "Hello, this is your AI Call Copilot. I'm here to help you during this conversation.";

const PLAIN_ENGLISH = (accentLabel: string) => `Clear, natural ${accentLabel} voice for everyday conversations and coaching.`;
const POLISHED_ENGLISH = (accentLabel: string) =>
  `Polished ${accentLabel} voice for client-facing calls and formal coaching.`;

// Sarvam speakers were chosen from measured pitch (their docs give no gender):
// female priya/ritu/kavya sit at ~220-230 Hz, male shubh/aditya/amit at ~108-144 Hz.
// Whether "professional"/"friendly" suits a given speaker can only be judged by
// listening (that is what Preview is for) — swapping one is a one-line change here.
export const VOICE_CATALOG: readonly CatalogVoice[] = [
  // --- Indian English (Sarvam) ---
  {
    voiceId: 'in-female',
    displayName: 'Indian English – Female',
    accent: 'indian',
    gender: 'female',
    language: 'en-IN',
    defaultPersonality: 'conversational',
    description: 'Warm, natural Indian English voice for everyday conversations and coaching.',
    provider: 'sarvam',
    providerRef: { speaker: 'priya' },
  },
  {
    voiceId: 'in-male',
    displayName: 'Indian English – Male',
    accent: 'indian',
    gender: 'male',
    language: 'en-IN',
    defaultPersonality: 'conversational',
    description: 'Natural, easy-going Indian English voice for everyday conversations and coaching.',
    provider: 'sarvam',
    providerRef: { speaker: 'shubh' },
  },
  {
    voiceId: 'in-professional-female',
    displayName: 'Professional Indian – Female',
    accent: 'indian',
    gender: 'female',
    language: 'en-IN',
    defaultPersonality: 'professional',
    description: 'Clear, confident and professional voice suitable for customer conversations and sales calls.',
    provider: 'sarvam',
    providerRef: { speaker: 'ritu' },
  },
  {
    voiceId: 'in-professional-male',
    displayName: 'Professional Indian – Male',
    accent: 'indian',
    gender: 'male',
    language: 'en-IN',
    defaultPersonality: 'professional',
    description: 'Steady, authoritative voice suitable for customer conversations and sales calls.',
    provider: 'sarvam',
    providerRef: { speaker: 'aditya' },
  },
  {
    voiceId: 'in-friendly-female',
    displayName: 'Friendly Indian – Female',
    accent: 'indian',
    gender: 'female',
    language: 'en-IN',
    defaultPersonality: 'friendly',
    description: 'Bright, approachable voice that keeps calls light and welcoming.',
    provider: 'sarvam',
    providerRef: { speaker: 'kavya' },
  },
  {
    voiceId: 'in-friendly-male',
    displayName: 'Friendly Indian – Male',
    accent: 'indian',
    gender: 'male',
    language: 'en-IN',
    defaultPersonality: 'friendly',
    description: 'Warm, upbeat voice that keeps calls light and welcoming.',
    provider: 'sarvam',
    providerRef: { speaker: 'amit' },
  },

  // --- Australian / American / British English (ElevenLabs) ---
  ...(
    [
      { prefix: 'au', accent: 'australian', language: 'en-AU', label: 'Australian', accentLabel: 'Australian English' },
      { prefix: 'us', accent: 'american', language: 'en-US', label: 'American', accentLabel: 'American English' },
      { prefix: 'gb', accent: 'british', language: 'en-GB', label: 'British', accentLabel: 'British English' },
    ] as const
  ).flatMap(({ prefix, accent, language, label, accentLabel }) =>
    // Plain female, plain male, Professional female, Professional male — the
    // order the voices are listed in, per accent.
    (['standard', 'professional'] as const).flatMap((variant) =>
      VOICE_GENDERS.map((gender): CatalogVoice => {
        const suffix = gender === 'female' ? 'Female' : 'Male';
        const professional = variant === 'professional';
        return {
          voiceId: professional ? `${prefix}-professional-${gender}` : `${prefix}-${gender}`,
          displayName: professional ? `Professional ${label} – ${suffix}` : `${accentLabel} – ${suffix}`,
          accent,
          gender,
          language,
          defaultPersonality: professional ? 'professional' : 'conversational',
          description: professional ? POLISHED_ENGLISH(accentLabel) : PLAIN_ENGLISH(accentLabel),
          provider: 'elevenlabs',
          providerRef: { accent, gender, variant },
        };
      }),
    ),
  ),
];

const BY_ID = new Map(VOICE_CATALOG.map((v) => [v.voiceId, v]));

export const VOICE_IDS: readonly string[] = VOICE_CATALOG.map((v) => v.voiceId);

export function getCatalogVoice(voiceId: string | null | undefined): CatalogVoice | undefined {
  return voiceId ? BY_ID.get(voiceId) : undefined;
}

export function isVoicePersonality(value: unknown): value is VoicePersonality {
  return typeof value === 'string' && (VOICE_PERSONALITIES as readonly string[]).includes(value);
}

/**
 * Non-English speech (Tamil, Hindi, ...) can only be spoken by Sarvam. When the
 * chosen voice is an ElevenLabs one, this picks the Indian voice that best
 * carries the same identity: same gender, and the one whose own personality
 * matches when there is one (otherwise the plain voice — the personality preset
 * still shapes its pace and expressiveness).
 */
export function sarvamVoiceFor(gender: VoiceGender, personality: VoicePersonality): CatalogVoice {
  const sarvam = VOICE_CATALOG.filter((v) => v.provider === 'sarvam' && v.gender === gender);
  return sarvam.find((v) => v.defaultPersonality === personality) ?? sarvam.find((v) => v.defaultPersonality === 'conversational')!;
}

/** The only shape of a voice that ever leaves the backend. */
export interface VoiceDto {
  voiceId: string;
  displayName: string;
  accent: VoiceAccent;
  accentLabel: string;
  gender: VoiceGender;
  language: string;
  personality: VoicePersonality;
  description: string;
  provider: string;
  isActive: boolean;
  unavailableReason: string | null;
  isDefault: boolean;
  isSelected: boolean;
}

export function toVoiceDto(
  voice: CatalogVoice,
  state: { isActive: boolean; unavailableReason: string | null; isDefault: boolean; isSelected: boolean },
): VoiceDto {
  return {
    voiceId: voice.voiceId,
    displayName: voice.displayName,
    accent: voice.accent,
    accentLabel: VOICE_ACCENT_LABELS[voice.accent],
    gender: voice.gender,
    language: voice.language,
    personality: voice.defaultPersonality,
    description: voice.description,
    provider: VOICE_PROVIDER_LABELS[voice.provider],
    ...state,
  };
}
