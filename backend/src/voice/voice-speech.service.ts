import { createHash } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  CatalogVoice,
  SYSTEM_DEFAULT_VOICE_ID,
  VOICE_SAMPLE_TEXT,
  VoicePersonality,
  getCatalogVoice,
  isVoicePersonality,
  sarvamVoiceFor,
} from './catalog/voice-catalog';
import { VoicePreview, VoicePreviewDocument } from './schemas/voice-preview.schema';
import { VoiceConfigService } from './voice-config.service';
import { unavailableReason } from './voice-resolution';
import { SynthesisResult, VoiceService } from './voice.service';

// The one place speech is produced for a person: every feature that speaks
// (chat voice replies, the Call Copilot AI Coach, anything later) reaches it
// through POST /voice/speak, and this applies that person's Voice & Accent
// configuration — so no feature needs, or can drift into having, its own voice
// setting.
@Injectable()
export class VoiceSpeechService {
  private readonly logger = new Logger(VoiceSpeechService.name);

  constructor(
    private config: VoiceConfigService,
    private voiceService: VoiceService,
    private organizations: OrganizationsService,
    @InjectModel(VoicePreview.name) private previews: Model<VoicePreviewDocument>,
  ) {}

  async speak(organizationId: string, userId: string, text: string, languageCode: string): Promise<SynthesisResult> {
    const resolved = await this.config.resolve(organizationId, userId);
    const chosen = this.voiceFor(resolved.voice, resolved.personality, languageCode);
    try {
      return await this.synthesize(organizationId, userId, chosen, text, languageCode, resolved.personality);
    } catch (err) {
      // Availability is checked up to a minute ahead, so a voice can still fail
      // at the moment of speaking (ElevenLabs quota used up, a provider blip).
      // One retry with the system default keeps a live call talking instead of
      // going silent; if that fails too, the original error — about the voice
      // actually chosen — is the one that surfaces. Only worth trying across
      // providers: a second attempt on the provider that just failed would only
      // make the person wait out another timeout.
      const fallback = this.voiceFor(getCatalogVoice(SYSTEM_DEFAULT_VOICE_ID)!, resolved.personality, languageCode);
      if (fallback.provider === chosen.provider) throw err;
      this.logger.warn(`Voice ${chosen.voiceId} failed (${(err as Error).message}) — retrying with ${fallback.voiceId}`);
      try {
        return await this.synthesize(organizationId, userId, fallback, text, languageCode, resolved.personality);
      } catch {
        throw err;
      }
    }
  }

  /** The Voice & Accent sample of one voice, served from cache after the first
   * time so repeated previews cost the provider nothing. An explicit voice — no
   * configuration or fallback applies — because the point is to hear exactly
   * that one. */
  async preview(user: JwtPayload, voiceId: string, personality?: VoicePersonality): Promise<SynthesisResult> {
    const voice = getCatalogVoice(voiceId);
    if (!voice) throw new NotFoundException('Unknown voice.');

    const [availability, org] = await Promise.all([
      this.config.getAvailability(),
      this.organizations.getVoiceSettings(user.organizationId),
    ]);
    const reason = unavailableReason(availability?.[voiceId]);
    if (reason) throw new BadRequestException(reason);

    // Same rule the real speech uses below the person's own choice: the
    // organization's default personality, then the voice's own style.
    const effective =
      personality ?? (isVoicePersonality(org.defaultPersonality) ? org.defaultPersonality : voice.defaultPersonality);

    // The key covers everything the audio depends on, so changing a voice's
    // provider selector or the sample sentence retires old clips on its own.
    const key = createHash('sha256')
      .update(JSON.stringify([voice.voiceId, voice.provider, voice.providerRef, effective, VOICE_SAMPLE_TEXT]))
      .digest('hex');
    const cached = await this.previews.findOne({ key }).exec();
    if (cached) return { audio: Buffer.from(cached.audio), contentType: cached.contentType };

    const result = await this.synthesize(user.organizationId, user.sub, voice, VOICE_SAMPLE_TEXT, 'en', effective);
    await this.previews
      .updateOne({ key }, { $set: { contentType: result.contentType, audio: result.audio, createdAt: new Date() } }, { upsert: true })
      .exec();
    return result;
  }

  // Non-English speech (Tamil, Hindi, ...) can only be spoken by Sarvam. When the
  // chosen voice is an ElevenLabs one, its Indian counterpart of the same
  // gender and personality speaks instead.
  private voiceFor(voice: CatalogVoice, personality: VoicePersonality, languageCode: string): CatalogVoice {
    if (languageCode === 'en' || voice.provider === 'sarvam') return voice;
    return sarvamVoiceFor(voice.gender, personality);
  }

  private synthesize(
    organizationId: string,
    userId: string,
    voice: CatalogVoice,
    text: string,
    languageCode: string,
    personality: VoicePersonality,
  ): Promise<SynthesisResult> {
    return this.voiceService.synthesize(organizationId, userId, {
      text,
      languageCode,
      provider: voice.provider,
      voiceRef: voice.providerRef,
      personality,
    });
  }
}
