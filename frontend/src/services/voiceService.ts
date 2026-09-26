import { axiosClient } from '@/api/axiosClient';
import { readBlobErrorBody } from '@/utils/errors';

// Matches backend/src/voice/dto/voice-languages.ts exactly — every one of
// these is already accepted end to end (NestJS DTO validation -> python-agent's
// SUPPORTED_LANGUAGES map -> Sarvam's BCP-47 codes), so the selector can offer
// them all. Drives the chat voice modal, the Call Copilot call language, and
// the AI Coach's spoken-feedback language.
export interface VoiceLanguageOption {
  code: string;
  label: string;
}

export const VOICE_LANGUAGES: VoiceLanguageOption[] = [
  { code: 'ta', label: 'Tamil' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'te', label: 'Telugu' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'bn', label: 'Bengali' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'od', label: 'Odia' },
];

export interface TranscribeResult {
  transcript: string;
  languageCode: string;
}

export const voiceService = {
  async transcribe(audio: Blob, languageCode: string): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('audio', audio, 'recording.webm');
    form.append('languageCode', languageCode);
    const { data } = await axiosClient.post<TranscribeResult>('/voice/transcribe', form);
    return data;
  },

  // No voice argument on purpose: which voice speaks is the caller's Voice &
  // Accent configuration, applied server-side, so every feature that speaks
  // (chat replies, the Call Copilot AI Coach, ...) uses it without a setting
  // of its own. The blob is WAV or MP3 depending on the voice — an <audio>
  // element plays either.
  async speak(text: string, languageCode: string): Promise<Blob> {
    try {
      const { data } = await axiosClient.post('/voice/speak', { text, languageCode }, { responseType: 'blob' });
      return data as Blob;
    } catch (err) {
      throw await readBlobErrorBody(err);
    }
  },
};
