import {
  SYSTEM_DEFAULT_VOICE_ID,
  VOICE_ACCENTS,
  VOICE_CATALOG,
  VOICE_GENDERS,
  VOICE_PERSONALITIES,
  getCatalogVoice,
  sarvamVoiceFor,
  toVoiceDto,
} from './catalog/voice-catalog';

describe('voice catalog', () => {
  it('offers exactly the 18 requested voices, named as requested', () => {
    expect(VOICE_CATALOG.map((v) => v.displayName)).toEqual([
      'Indian English – Female',
      'Indian English – Male',
      'Professional Indian – Female',
      'Professional Indian – Male',
      'Friendly Indian – Female',
      'Friendly Indian – Male',
      'Australian English – Female',
      'Australian English – Male',
      'Professional Australian – Female',
      'Professional Australian – Male',
      'American English – Female',
      'American English – Male',
      'Professional American – Female',
      'Professional American – Male',
      'British English – Female',
      'British English – Male',
      'Professional British – Female',
      'Professional British – Male',
    ]);
  });

  it('has unique, stable ids', () => {
    const ids = VOICE_CATALOG.map((v) => v.voiceId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('in-professional-female');
    expect(ids).toContain('gb-male');
  });

  it('covers every accent with both genders', () => {
    for (const accent of VOICE_ACCENTS) {
      for (const gender of VOICE_GENDERS) {
        expect(VOICE_CATALOG.some((v) => v.accent === accent && v.gender === gender)).toBe(true);
      }
    }
  });

  it('gives every voice a valid default personality, description and locale', () => {
    for (const voice of VOICE_CATALOG) {
      expect(VOICE_PERSONALITIES).toContain(voice.defaultPersonality);
      expect(voice.description.length).toBeGreaterThan(10);
      expect(voice.language).toMatch(/^en-[A-Z]{2}$/);
    }
  });

  it('routes Indian voices to Sarvam and the rest to ElevenLabs, with well-formed provider refs', () => {
    for (const voice of VOICE_CATALOG) {
      if (voice.accent === 'indian') {
        expect(voice.provider).toBe('sarvam');
        expect(voice.providerRef.speaker).toMatch(/^[a-z]+$/);
      } else {
        expect(voice.provider).toBe('elevenlabs');
        expect(voice.providerRef).toEqual({
          accent: voice.accent,
          gender: voice.gender,
          variant: voice.voiceId.includes('-professional-') ? 'professional' : 'standard',
        });
      }
    }
  });

  it('never assigns one Sarvam speaker to two voices', () => {
    const speakers = VOICE_CATALOG.filter((v) => v.provider === 'sarvam').map((v) => v.providerRef.speaker);
    expect(new Set(speakers).size).toBe(speakers.length);
  });

  it('defaults to a Sarvam voice, so unconfigured behavior is unchanged and needs no second provider', () => {
    const system = getCatalogVoice(SYSTEM_DEFAULT_VOICE_ID);
    expect(system?.provider).toBe('sarvam');
    expect(system?.providerRef.speaker).toBe('shubh');
  });

  it('never exposes provider-private fields in the DTO sent to the browser', () => {
    const dto = toVoiceDto(VOICE_CATALOG[0], { isActive: true, unavailableReason: null, isDefault: false, isSelected: false });
    expect(dto).not.toHaveProperty('providerRef');
    expect(JSON.stringify(dto)).not.toContain('priya');
    expect(dto.provider).toBe('Sarvam AI');
  });

  describe('sarvamVoiceFor (non-English speech on behalf of an ElevenLabs voice)', () => {
    it('keeps the gender', () => {
      for (const gender of VOICE_GENDERS) {
        for (const personality of VOICE_PERSONALITIES) {
          const voice = sarvamVoiceFor(gender, personality);
          expect(voice.provider).toBe('sarvam');
          expect(voice.gender).toBe(gender);
        }
      }
    });

    it('prefers the Indian voice whose own personality matches, else the plain one', () => {
      expect(sarvamVoiceFor('female', 'professional').voiceId).toBe('in-professional-female');
      expect(sarvamVoiceFor('male', 'friendly').voiceId).toBe('in-friendly-male');
      expect(sarvamVoiceFor('female', 'calm').voiceId).toBe('in-female');
    });
  });
});
