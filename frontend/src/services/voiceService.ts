import { axiosClient } from '@/api/axiosClient';

// Matches backend/src/voice/dto/voice-languages.ts exactly — the initial 3
// requested languages first, the rest already Sarvam-verified and ready
// once the product wants to enable them (no backend change needed to add
// one — just uncomment/add it here).
export interface VoiceLanguageOption {
  code: string;
  label: string;
}

export const VOICE_LANGUAGES: VoiceLanguageOption[] = [
  { code: 'ta', label: 'Tamil' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  // { code: 'te', label: 'Telugu' },
  // { code: 'kn', label: 'Kannada' },
  // { code: 'ml', label: 'Malayalam' },
  // { code: 'bn', label: 'Bengali' },
  // { code: 'mr', label: 'Marathi' },
  // { code: 'gu', label: 'Gujarati' },
  // { code: 'pa', label: 'Punjabi' },
  // { code: 'od', label: 'Odia' },
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

  async speak(text: string, languageCode: string): Promise<Blob> {
    const { data } = await axiosClient.post('/voice/speak', { text, languageCode }, { responseType: 'blob' });
    return data as Blob;
  },
};
