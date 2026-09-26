import { SYSTEM_DEFAULT_VOICE_ID } from './catalog/voice-catalog';
import { AvailabilityMap, resolveVoice, unavailableReason } from './voice-resolution';

const up = (): AvailabilityMap => ({});
const down = (...ids: string[]): AvailabilityMap =>
  Object.fromEntries(ids.map((id) => [id, { available: false, reason: `${id} is down` }]));

describe('resolveVoice', () => {
  it('falls back to the system default when nothing is configured', () => {
    const r = resolveVoice({}, {}, up());
    expect(r.voice.voiceId).toBe(SYSTEM_DEFAULT_VOICE_ID);
    expect(r.source).toBe('system');
    expect(r.fallback).toBeNull();
  });

  it("uses the organization's default over the system default", () => {
    const r = resolveVoice({ defaultVoiceId: 'gb-female' }, {}, up());
    expect(r.voice.voiceId).toBe('gb-female');
    expect(r.source).toBe('organization');
  });

  it("uses the person's own choice over the organization's default", () => {
    const r = resolveVoice({ defaultVoiceId: 'gb-female' }, { voiceId: 'in-friendly-male' }, up());
    expect(r.voice.voiceId).toBe('in-friendly-male');
    expect(r.source).toBe('user');
  });

  it('ignores personal choices (voice and personality) while the organization disallows overrides', () => {
    const r = resolveVoice(
      { defaultVoiceId: 'gb-female', defaultPersonality: 'calm', allowUserOverride: false },
      { voiceId: 'in-friendly-male', personality: 'energetic' },
      up(),
    );
    expect(r.voice.voiceId).toBe('gb-female');
    expect(r.source).toBe('organization');
    expect(r.personality).toBe('calm');
    expect(r.personalitySource).toBe('organization');
  });

  it('treats a missing allowUserOverride as allowed and only an explicit false as blocking', () => {
    expect(resolveVoice({}, { voiceId: 'in-female' }, up()).source).toBe('user');
    expect(resolveVoice({ allowUserOverride: true }, { voiceId: 'in-female' }, up()).source).toBe('user');
    expect(resolveVoice({ allowUserOverride: false }, { voiceId: 'in-female' }, up()).source).toBe('system');
  });

  describe('personality precedence: person -> organization -> the voice itself', () => {
    it("falls to the voice's own personality", () => {
      const r = resolveVoice({}, { voiceId: 'in-professional-female' }, up());
      expect(r.personality).toBe('professional');
      expect(r.personalitySource).toBe('voice');
    });

    it("prefers the organization's default personality over the voice's", () => {
      const r = resolveVoice({ defaultPersonality: 'calm' }, { voiceId: 'in-professional-female' }, up());
      expect(r.personality).toBe('calm');
      expect(r.personalitySource).toBe('organization');
    });

    it("prefers the person's personality over both", () => {
      const r = resolveVoice({ defaultPersonality: 'calm' }, { voiceId: 'in-professional-female', personality: 'energetic' }, up());
      expect(r.personality).toBe('energetic');
      expect(r.personalitySource).toBe('user');
    });

    it('lets a person change only the personality and keep the organization voice', () => {
      const r = resolveVoice({ defaultVoiceId: 'gb-male' }, { personality: 'friendly' }, up());
      expect(r.voice.voiceId).toBe('gb-male');
      expect(r.source).toBe('organization');
      expect(r.personality).toBe('friendly');
    });

    it('ignores a personality outside the vocabulary', () => {
      const r = resolveVoice({ defaultPersonality: 'sarcastic' }, { personality: 'grumpy' }, up());
      expect(r.personalitySource).toBe('voice');
    });
  });

  describe('graceful fallback', () => {
    it("skips an unavailable personal choice for the organization's default and says why", () => {
      const r = resolveVoice({ defaultVoiceId: 'in-female' }, { voiceId: 'au-female' }, down('au-female'));
      expect(r.voice.voiceId).toBe('in-female');
      expect(r.source).toBe('organization');
      expect(r.fallback).toEqual({
        requestedVoiceId: 'au-female',
        requestedDisplayName: 'Australian English – Female',
        requestedFrom: 'user',
        reason: 'au-female is down',
      });
    });

    it('falls to the system default when both choices are unavailable, reporting the first skipped', () => {
      const r = resolveVoice({ defaultVoiceId: 'us-male' }, { voiceId: 'gb-male' }, down('gb-male', 'us-male'));
      expect(r.voice.voiceId).toBe(SYSTEM_DEFAULT_VOICE_ID);
      expect(r.source).toBe('system');
      expect(r.fallback?.requestedVoiceId).toBe('gb-male');
      expect(r.fallback?.requestedFrom).toBe('user');
    });

    it('reports an organization default that is unavailable', () => {
      const r = resolveVoice({ defaultVoiceId: 'gb-female' }, {}, down('gb-female'));
      expect(r.voice.voiceId).toBe(SYSTEM_DEFAULT_VOICE_ID);
      expect(r.fallback?.requestedFrom).toBe('organization');
    });

    it('skips a stored voice id that is no longer in the catalog', () => {
      const r = resolveVoice({ defaultVoiceId: 'retired-voice' }, {}, up());
      expect(r.voice.voiceId).toBe(SYSTEM_DEFAULT_VOICE_ID);
      expect(r.fallback).toMatchObject({ requestedVoiceId: 'retired-voice', reason: 'This voice is no longer offered.' });
    });

    it('still returns the system default when even it is unavailable (its own error should surface)', () => {
      const r = resolveVoice({ defaultVoiceId: 'gb-female' }, {}, down('gb-female', SYSTEM_DEFAULT_VOICE_ID));
      expect(r.voice.voiceId).toBe(SYSTEM_DEFAULT_VOICE_ID);
      expect(r.fallback?.requestedVoiceId).toBe('gb-female');
    });

    it('fails open when availability could not be checked', () => {
      const r = resolveVoice({ defaultVoiceId: 'gb-female' }, { voiceId: 'au-male' }, null);
      expect(r.voice.voiceId).toBe('au-male');
      expect(r.fallback).toBeNull();
    });
  });
});

describe('unavailableReason', () => {
  it('is null for a usable or unknown voice', () => {
    expect(unavailableReason(undefined)).toBeNull();
    expect(unavailableReason({ available: true, reason: null })).toBeNull();
  });

  it('carries the provider reason, with a default when none was given', () => {
    expect(unavailableReason({ available: false, reason: 'No key' })).toBe('No key');
    expect(unavailableReason({ available: false, reason: null })).toBe('This voice is unavailable right now.');
  });
});
