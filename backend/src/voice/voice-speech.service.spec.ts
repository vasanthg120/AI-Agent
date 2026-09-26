import { BadRequestException, BadGatewayException, NotFoundException } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { VOICE_SAMPLE_TEXT } from './catalog/voice-catalog';
import { resolveVoice } from './voice-resolution';
import { VoiceSpeechService } from './voice-speech.service';

const user: JwtPayload = { sub: 'user-1', email: 'u@example.com', roles: ['user'], organizationId: 'org-1' };
const wav = { audio: Buffer.from('wav'), contentType: 'audio/wav' };
const mp3 = { audio: Buffer.from('mp3'), contentType: 'audio/mpeg' };

function setup(opts: { org?: object; prefs?: object; availability?: Record<string, { available: boolean; reason: string | null }> | null; cached?: any } = {}) {
  const org = opts.org ?? {};
  const prefs = opts.prefs ?? {};
  const availability = opts.availability === undefined ? {} : opts.availability;

  const config = {
    resolve: jest.fn(async () => resolveVoice(org, prefs, availability)),
    getAvailability: jest.fn(async () => availability),
  };
  const voiceService = { synthesize: jest.fn() };
  const organizations = { getVoiceSettings: jest.fn(async () => org) };
  const previews = {
    findOne: jest.fn(() => ({ exec: async () => opts.cached ?? null })),
    updateOne: jest.fn(() => ({ exec: async () => ({}) })),
  };
  const service = new VoiceSpeechService(config as any, voiceService as any, organizations as any, previews as any);
  return { service, voiceService, previews, config };
}

describe('VoiceSpeechService.speak', () => {
  it("speaks English with the resolved voice's provider, selector and personality", async () => {
    const { service, voiceService } = setup({ org: { defaultVoiceId: 'in-professional-female' } });
    voiceService.synthesize.mockResolvedValue(wav);

    const result = await service.speak('org-1', 'user-1', 'Hello', 'en');

    expect(result).toBe(wav);
    expect(voiceService.synthesize).toHaveBeenCalledTimes(1);
    expect(voiceService.synthesize).toHaveBeenCalledWith('org-1', 'user-1', {
      text: 'Hello',
      languageCode: 'en',
      provider: 'sarvam',
      voiceRef: { speaker: 'ritu' },
      personality: 'professional',
    });
  });

  it('speaks with ElevenLabs when an ElevenLabs voice is configured', async () => {
    const { service, voiceService } = setup({ prefs: { voiceId: 'gb-professional-male', personality: 'calm' } });
    voiceService.synthesize.mockResolvedValue(mp3);

    const result = await service.speak('org-1', 'user-1', 'Hello', 'en');

    expect(result.contentType).toBe('audio/mpeg');
    expect(voiceService.synthesize.mock.calls[0][2]).toMatchObject({
      provider: 'elevenlabs',
      voiceRef: { accent: 'british', gender: 'male', variant: 'professional' },
      personality: 'calm',
    });
  });

  it('speaks non-English with a same-gender Sarvam voice when an ElevenLabs voice is chosen', async () => {
    const { service, voiceService } = setup({ prefs: { voiceId: 'us-professional-female' } });
    voiceService.synthesize.mockResolvedValue(wav);

    await service.speak('org-1', 'user-1', 'வணக்கம்', 'ta');

    expect(voiceService.synthesize.mock.calls[0][2]).toMatchObject({
      languageCode: 'ta',
      provider: 'sarvam',
      voiceRef: { speaker: 'ritu' }, // Professional Indian – Female: same gender, matching personality
      personality: 'professional',
    });
  });

  it('keeps the chosen Sarvam voice for non-English speech', async () => {
    const { service, voiceService } = setup({ prefs: { voiceId: 'in-friendly-male' } });
    voiceService.synthesize.mockResolvedValue(wav);

    await service.speak('org-1', 'user-1', 'नमस्ते', 'hi');

    expect(voiceService.synthesize.mock.calls[0][2]).toMatchObject({ languageCode: 'hi', voiceRef: { speaker: 'amit' } });
  });

  it('skips an unavailable chosen voice up front and speaks with the organization default', async () => {
    const { service, voiceService } = setup({
      org: { defaultVoiceId: 'in-female' },
      prefs: { voiceId: 'au-female' },
      availability: { 'au-female': { available: false, reason: 'no voice' } },
    });
    voiceService.synthesize.mockResolvedValue(wav);

    await service.speak('org-1', 'user-1', 'Hello', 'en');

    expect(voiceService.synthesize).toHaveBeenCalledTimes(1);
    expect(voiceService.synthesize.mock.calls[0][2]).toMatchObject({ provider: 'sarvam', voiceRef: { speaker: 'priya' } });
  });

  describe('runtime fallback (a voice that was available a moment ago fails while speaking)', () => {
    it('retries once with the system default when an ElevenLabs voice fails', async () => {
      const { service, voiceService } = setup({ prefs: { voiceId: 'gb-female' } });
      voiceService.synthesize.mockRejectedValueOnce(new BadGatewayException('ElevenLabs quota used up')).mockResolvedValueOnce(wav);

      const result = await service.speak('org-1', 'user-1', 'Hello', 'en');

      expect(result).toBe(wav);
      expect(voiceService.synthesize).toHaveBeenCalledTimes(2);
      expect(voiceService.synthesize.mock.calls[0][2].provider).toBe('elevenlabs');
      expect(voiceService.synthesize.mock.calls[1][2]).toMatchObject({ provider: 'sarvam', voiceRef: { speaker: 'shubh' } });
    });

    it('surfaces the original error when the retry fails too', async () => {
      const { service, voiceService } = setup({ prefs: { voiceId: 'gb-female' } });
      const original = new BadGatewayException('ElevenLabs quota used up');
      voiceService.synthesize.mockRejectedValueOnce(original).mockRejectedValueOnce(new BadGatewayException('Sarvam down'));

      await expect(service.speak('org-1', 'user-1', 'Hello', 'en')).rejects.toBe(original);
    });

    it('does not retry on the provider that just failed', async () => {
      const { service, voiceService } = setup({ prefs: { voiceId: 'in-friendly-female' } });
      voiceService.synthesize.mockRejectedValue(new BadGatewayException('Sarvam down'));

      await expect(service.speak('org-1', 'user-1', 'Hello', 'en')).rejects.toThrow('Sarvam down');
      expect(voiceService.synthesize).toHaveBeenCalledTimes(1);
    });

    it('does not retry when the system default itself is what failed', async () => {
      const { service, voiceService } = setup();
      voiceService.synthesize.mockRejectedValue(new BadGatewayException('Sarvam down'));

      await expect(service.speak('org-1', 'user-1', 'Hello', 'en')).rejects.toThrow('Sarvam down');
      expect(voiceService.synthesize).toHaveBeenCalledTimes(1);
    });
  });
});

describe('VoiceSpeechService.preview', () => {
  it('rejects an unknown voice', async () => {
    const { service } = setup();
    await expect(service.preview(user, 'no-such-voice')).rejects.toThrow(NotFoundException);
  });

  it("rejects a voice that can't be spoken right now, with the reason", async () => {
    const { service, voiceService } = setup({ availability: { 'au-female': { available: false, reason: 'ElevenLabs isn\'t connected' } } });
    await expect(service.preview(user, 'au-female')).rejects.toThrow(new BadRequestException("ElevenLabs isn't connected"));
    expect(voiceService.synthesize).not.toHaveBeenCalled();
  });

  it('synthesizes the fixed sample sentence with exactly the requested voice, then caches it', async () => {
    const { service, voiceService, previews } = setup();
    voiceService.synthesize.mockResolvedValue(wav);

    const result = await service.preview(user, 'in-professional-male', 'calm');

    expect(result).toBe(wav);
    expect(voiceService.synthesize).toHaveBeenCalledWith('org-1', 'user-1', {
      text: VOICE_SAMPLE_TEXT,
      languageCode: 'en',
      provider: 'sarvam',
      voiceRef: { speaker: 'aditya' },
      personality: 'calm',
    });
    expect(previews.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = previews.updateOne.mock.calls[0] as any[];
    expect(filter.key).toMatch(/^[0-9a-f]{64}$/);
    expect(update.$set).toMatchObject({ contentType: 'audio/wav', audio: wav.audio });
    expect(options).toEqual({ upsert: true });
  });

  it('serves a cached preview without calling the provider', async () => {
    const { service, voiceService, previews } = setup({ cached: { audio: Buffer.from('cached'), contentType: 'audio/mpeg' } });

    const result = await service.preview(user, 'gb-female');

    expect(result.contentType).toBe('audio/mpeg');
    expect(result.audio.toString()).toBe('cached');
    expect(voiceService.synthesize).not.toHaveBeenCalled();
    expect(previews.updateOne).not.toHaveBeenCalled();
  });

  it("uses the organization's default personality when none is requested, else the voice's own", async () => {
    const withOrg = setup({ org: { defaultPersonality: 'energetic' } });
    withOrg.voiceService.synthesize.mockResolvedValue(wav);
    await withOrg.service.preview(user, 'in-friendly-female');
    expect(withOrg.voiceService.synthesize.mock.calls[0][2].personality).toBe('energetic');

    const plain = setup();
    plain.voiceService.synthesize.mockResolvedValue(wav);
    await plain.service.preview(user, 'in-friendly-female');
    expect(plain.voiceService.synthesize.mock.calls[0][2].personality).toBe('friendly');
  });

  it('caches per voice and personality (different keys)', async () => {
    const { service, voiceService, previews } = setup();
    voiceService.synthesize.mockResolvedValue(wav);

    await service.preview(user, 'in-female', 'calm');
    await service.preview(user, 'in-female', 'energetic');
    await service.preview(user, 'in-male', 'calm');

    const keys = previews.updateOne.mock.calls.map((c: any[]) => c[0].key);
    expect(new Set(keys).size).toBe(3);
  });
});
