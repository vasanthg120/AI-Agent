import { HttpService } from '@nestjs/axios';
import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import FormData from 'form-data';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

export interface TranscribeResult {
  transcript: string;
  languageCode: string;
}

export interface SynthesisRequest {
  text: string;
  languageCode: string;
  provider: string;
  voiceRef: Record<string, string>;
  personality?: string;
}

export interface SynthesisResult {
  audio: Buffer;
  contentType: string;
}

export interface AvailabilityQuery {
  voiceId: string;
  provider: string;
  voiceRef: Record<string, string>;
}

export interface VoiceAvailabilityResult {
  available: boolean;
  reason: string | null;
}

const AVAILABILITY_TIMEOUT_MS = 8_000;

// Pure pass-through to python-agent's /voice/* routes (which own the actual
// Sarvam AI call) — mirrors finance-documents.service.ts's callExtraction
// idiom exactly: a short-lived (5m) service JWT as the bridge credential,
// FormData for the multipart leg, forwarded organizationId/userId so
// python-agent's get_current_user has everything it needs. This service
// never sees SARVAM_API_KEY and never talks to Sarvam directly.
@Injectable()
export class VoiceService {
  private readonly pythonAgentUrl: string;

  constructor(
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private bridgeToken(userId: string, organizationId: string): string {
    return this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '5m' });
  }

  async transcribe(organizationId: string, userId: string, file: Express.Multer.File, languageCode: string): Promise<TranscribeResult> {
    const token = this.bridgeToken(userId, organizationId);
    const form = new FormData();
    form.append('audio', file.buffer, { filename: file.originalname, contentType: file.mimetype });
    form.append('languageCode', languageCode);

    try {
      const { data } = await firstValueFrom(
        this.http.post<TranscribeResult>(`${this.pythonAgentUrl}/voice/transcribe`, form, {
          headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }),
      );
      return data;
    } catch (err) {
      throw this.toHttpError(err);
    }
  }

  /** One text-to-speech call with the provider, voice and personality already
   * decided — this bridge never chooses a voice (VoiceSpeechService does, from
   * the caller's Voice & Accent configuration). Returns the provider's own
   * content type: Sarvam speaks WAV, ElevenLabs MP3. */
  async synthesize(organizationId: string, userId: string, request: SynthesisRequest): Promise<SynthesisResult> {
    const token = this.bridgeToken(userId, organizationId);
    try {
      const response = await firstValueFrom(
        this.http.post(`${this.pythonAgentUrl}/voice/speak`, request, {
          headers: { Authorization: `Bearer ${token}` },
          responseType: 'arraybuffer',
        }),
      );
      const contentType = String(response.headers['content-type'] ?? 'audio/wav').split(';')[0].trim();
      return { audio: Buffer.from(response.data as ArrayBuffer), contentType };
    } catch (err) {
      throw this.toHttpError(err);
    }
  }

  /** Which of these voices can be spoken right now (provider connected and the
   * voice exists there). Costs nothing — python-agent makes no synthesis call.
   * Short timeout: this backs the settings page, which must not hang because a
   * provider is slow (the caller fails open on any error). */
  async checkAvailability(voices: AvailabilityQuery[]): Promise<Record<string, VoiceAvailabilityResult>> {
    const token = this.bridgeToken('voice-config', 'platform');
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ voices: Record<string, VoiceAvailabilityResult> }>(
          `${this.pythonAgentUrl}/voice/availability`,
          { voices },
          { headers: { Authorization: `Bearer ${token}` }, timeout: AVAILABILITY_TIMEOUT_MS },
        ),
      );
      return data.voices;
    } catch (err) {
      throw this.toHttpError(err);
    }
  }

  // python-agent's HTTPException detail is already a clean, user-safe
  // message (see app/routes/voice.py) — this just re-throws it as the
  // equivalent Nest exception instead of a generic 500, without leaking any
  // Axios/Sarvam internals.
  private toHttpError(err: unknown): BadGatewayException {
    const axiosErr = err as AxiosError<{ detail?: string } | ArrayBuffer>;
    let detail: unknown = axiosErr.response?.data;
    // /voice/speak's error responses come back through the same
    // responseType:'arraybuffer' as its success path — decode it as JSON
    // before checking for a `.detail` string, rather than treating every
    // error there as unparseable.
    if (detail instanceof ArrayBuffer || Buffer.isBuffer(detail)) {
      try {
        detail = JSON.parse(Buffer.from(detail as ArrayBuffer).toString('utf8'));
      } catch {
        detail = undefined;
      }
    }
    const message =
      detail && typeof detail === 'object' && typeof (detail as { detail?: string }).detail === 'string'
        ? (detail as { detail: string }).detail
        : 'Unable to reach the voice service. Please try again.';
    return new BadGatewayException(message);
  }
}
