// Short ISO codes this app's voice feature accepts end-to-end (frontend
// selector -> this DTO validation -> python-agent's SUPPORTED_LANGUAGES map
// -> Sarvam's BCP-47 codes). Kept in one place so the NestJS DTO's allowed
// values can never silently drift from what python-agent/Sarvam actually
// support. Initial 3 languages per the request; the rest are Sarvam-verified
// and ready to enable in the frontend selector without any backend change.
export const VOICE_LANGUAGE_CODES = ['ta', 'en', 'hi', 'te', 'kn', 'ml', 'bn', 'mr', 'gu', 'pa', 'od'] as const;
export type VoiceLanguageCode = (typeof VOICE_LANGUAGE_CODES)[number];
