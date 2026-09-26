import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { VOICE_CATALOG } from './catalog/voice-catalog';
import { VoiceConfigService } from './voice-config.service';

const member: JwtPayload = { sub: 'user-1', email: 'u@example.com', roles: ['user'], organizationId: 'org-1' };
const admin: JwtPayload = { ...member, sub: 'admin-1', roles: ['owner', 'admin'] };

type Availability = Record<string, { available: boolean; reason: string | null }>;

function setup(state: { org?: any; prefs?: any; availability?: Availability | Error } = {}) {
  const store = { org: { ...(state.org ?? {}) }, prefs: { ...(state.prefs ?? {}) } };

  const organizations = {
    getVoiceSettings: jest.fn(async () => ({ ...store.org })),
    updateVoiceSettings: jest.fn(async (_orgId: string, patch: any, updatedBy: string) => {
      for (const key of ['defaultVoiceId', 'defaultPersonality'] as const) {
        if (patch[key] === null) delete store.org[key];
        else if (patch[key] !== undefined) store.org[key] = patch[key];
      }
      if (patch.allowUserOverride !== undefined) store.org.allowUserOverride = patch.allowUserOverride;
      store.org.updatedBy = updatedBy;
      store.org.updatedAt = new Date('2026-09-24T10:00:00Z');
      return { ...store.org };
    }),
  };
  const users = {
    getVoicePreferences: jest.fn(async () => ({ ...store.prefs })),
    updateVoicePreferences: jest.fn(async (_id: string, patch: any) => {
      for (const key of ['voiceId', 'personality'] as const) {
        if (patch[key] === null) delete store.prefs[key];
        else if (patch[key] !== undefined) store.prefs[key] = patch[key];
      }
      return { ...store.prefs };
    }),
    findById: jest.fn(async (id: string) => (id === 'admin-1' ? { name: 'Asha Admin' } : null)),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const voiceService = {
    checkAvailability: jest.fn(async () => {
      if (state.availability instanceof Error) throw state.availability;
      return state.availability ?? {};
    }),
  };
  const service = new VoiceConfigService(organizations as any, users as any, audit as any, voiceService as any);
  return { service, organizations, users, audit, voiceService, store };
}

describe('VoiceConfigService.getConfig', () => {
  it('returns all 18 voices with default/selected/active flags and the active voice', async () => {
    const { service } = setup({
      org: { defaultVoiceId: 'gb-female', defaultPersonality: 'calm', updatedBy: 'admin-1', updatedAt: new Date('2026-09-20T08:00:00Z') },
      prefs: { voiceId: 'in-friendly-male' },
    });

    const config = await service.getConfig(member);

    expect(config.voices).toHaveLength(VOICE_CATALOG.length);
    expect(config.voices.find((v) => v.voiceId === 'gb-female')).toMatchObject({ isDefault: true, isSelected: false, isActive: true });
    expect(config.voices.find((v) => v.voiceId === 'in-friendly-male')).toMatchObject({ isDefault: false, isSelected: true });
    expect(config.active).toMatchObject({ voiceId: 'in-friendly-male', source: 'user', personality: 'calm', personalitySource: 'organization' });
    expect(config.organization).toMatchObject({
      defaultVoiceId: 'gb-female',
      defaultPersonality: 'calm',
      allowUserOverride: true,
      updatedAt: '2026-09-20T08:00:00.000Z',
      updatedByName: 'Asha Admin',
    });
    expect(config.canChooseOwnVoice).toBe(true);
    expect(config.availabilityChecked).toBe(true);
  });

  it('only lets owners/admins configure the organization', async () => {
    const { service } = setup();
    expect((await service.getConfig(member)).canConfigureOrganization).toBe(false);
    expect((await service.getConfig(admin)).canConfigureOrganization).toBe(true);
    expect((await service.getConfig({ ...member, roles: ['owner'] })).canConfigureOrganization).toBe(true);
  });

  it('marks unavailable voices with their reason and reports the fallback in effect', async () => {
    const { service } = setup({
      org: { defaultVoiceId: 'in-female' },
      prefs: { voiceId: 'au-male' },
      availability: { 'au-male': { available: false, reason: 'ElevenLabs isn\'t connected' } },
    });

    const config = await service.getConfig(member);

    expect(config.voices.find((v) => v.voiceId === 'au-male')).toMatchObject({ isActive: false, unavailableReason: "ElevenLabs isn't connected" });
    expect(config.active).toMatchObject({ voiceId: 'in-female', source: 'organization' });
    expect(config.active.fallback).toMatchObject({ requestedVoiceId: 'au-male', requestedFrom: 'user' });
  });

  it('fails open and says so when the availability check fails', async () => {
    const { service } = setup({ prefs: { voiceId: 'au-male' }, availability: new Error('python-agent down') });

    const config = await service.getConfig(member);

    expect(config.availabilityChecked).toBe(false);
    expect(config.voices.every((v) => v.isActive)).toBe(true);
    expect(config.active.voiceId).toBe('au-male');
  });

  it('shows no personal selection while the organization disallows overrides', async () => {
    const { service } = setup({ org: { defaultVoiceId: 'gb-male', allowUserOverride: false }, prefs: { voiceId: 'in-female' } });

    const config = await service.getConfig(member);

    expect(config.canChooseOwnVoice).toBe(false);
    expect(config.voices.some((v) => v.isSelected)).toBe(false);
    expect(config.active).toMatchObject({ voiceId: 'gb-male', source: 'organization' });
  });

  it('checks availability once and reuses it, and shares one in-flight check between concurrent callers', async () => {
    const { service, voiceService } = setup();

    await Promise.all([service.getConfig(member), service.getConfig(member), service.getConfig(admin)]);
    await service.getConfig(member);

    expect(voiceService.checkAvailability).toHaveBeenCalledTimes(1);
    const sent = (voiceService.checkAvailability.mock.calls[0] as any[])[0] as any[];
    expect(sent).toHaveLength(VOICE_CATALOG.length);
    expect(sent[0]).toEqual({ voiceId: 'in-female', provider: 'sarvam', voiceRef: { speaker: 'priya' } });
  });
});

describe('VoiceConfigService.updateOrganization', () => {
  it('saves the change, stamps who made it, and audits before/after', async () => {
    const { service, organizations, audit } = setup({ org: { defaultVoiceId: 'in-female' } });

    const config = await service.updateOrganization(admin, { defaultVoiceId: 'gb-professional-female', defaultPersonality: 'calm', allowUserOverride: false }, '10.0.0.1');

    expect(organizations.updateVoiceSettings).toHaveBeenCalledWith(
      'org-1',
      { defaultVoiceId: 'gb-professional-female', defaultPersonality: 'calm', allowUserOverride: false },
      'admin-1',
    );
    expect(config.organization).toMatchObject({ defaultVoiceId: 'gb-professional-female', allowUserOverride: false, updatedByName: 'Asha Admin' });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        organizationId: 'org-1',
        ip: '10.0.0.1',
        action: 'voice.organization_settings.updated',
        metadata: {
          before: { defaultVoiceId: 'in-female', defaultPersonality: null, allowUserOverride: true },
          after: { defaultVoiceId: 'gb-professional-female', defaultPersonality: 'calm', allowUserOverride: false },
        },
      }),
    );
  });

  it('clears a field with null', async () => {
    const { service, store } = setup({ org: { defaultVoiceId: 'in-female', defaultPersonality: 'calm' } });

    await service.updateOrganization(admin, { defaultVoiceId: null });

    expect(store.org.defaultVoiceId).toBeUndefined();
    expect(store.org.defaultPersonality).toBe('calm');
  });

  it('refuses a default voice that cannot be spoken right now', async () => {
    const { service, organizations, audit } = setup({ availability: { 'au-female': { available: false, reason: 'no matching voice' } } });

    await expect(service.updateOrganization(admin, { defaultVoiceId: 'au-female' })).rejects.toThrow(BadRequestException);
    expect(organizations.updateVoiceSettings).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('allows a default voice when availability could not be checked', async () => {
    const { service, organizations } = setup({ availability: new Error('down') });
    await service.updateOrganization(admin, { defaultVoiceId: 'au-female' });
    expect(organizations.updateVoiceSettings).toHaveBeenCalled();
  });

  it('does not audit a save that changed nothing', async () => {
    const { service, audit } = setup({ org: { defaultVoiceId: 'in-female' } });
    await service.updateOrganization(admin, { defaultVoiceId: 'in-female' });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('does nothing for an empty update', async () => {
    const { service, organizations, audit } = setup();
    await service.updateOrganization(admin, {});
    expect(organizations.updateVoiceSettings).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('VoiceConfigService.updateMyPreference', () => {
  it('saves a personal choice and audits before/after', async () => {
    const { service, users, audit } = setup({ prefs: { voiceId: 'in-female' } });

    const config = await service.updateMyPreference(member, { voiceId: 'us-male', personality: 'confident' }, '10.0.0.2');

    expect(users.updateVoicePreferences).toHaveBeenCalledWith('user-1', { voiceId: 'us-male', personality: 'confident' });
    expect(config.user).toEqual({ voiceId: 'us-male', personality: 'confident' });
    expect(config.active).toMatchObject({ voiceId: 'us-male', source: 'user', personality: 'confident', personalitySource: 'user' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'voice.user_preference.updated',
        metadata: { before: { voiceId: 'in-female', personality: null }, after: { voiceId: 'us-male', personality: 'confident' } },
      }),
    );
  });

  it('is refused (403) when the organization has turned off personal selection', async () => {
    const { service, users, audit } = setup({ org: { allowUserOverride: false } });

    await expect(service.updateMyPreference(member, { voiceId: 'us-male' })).rejects.toThrow(ForbiddenException);
    expect(users.updateVoicePreferences).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('clears the personal choice with null so the organization voice applies again', async () => {
    const { service } = setup({ org: { defaultVoiceId: 'gb-male' }, prefs: { voiceId: 'in-female', personality: 'calm' } });

    const config = await service.updateMyPreference(member, { voiceId: null, personality: null });

    expect(config.user).toEqual({ voiceId: null, personality: null });
    expect(config.active).toMatchObject({ voiceId: 'gb-male', source: 'organization' });
  });

  it('refuses a personal choice that cannot be spoken right now', async () => {
    const { service, users } = setup({ availability: { 'gb-male': { available: false, reason: 'not connected' } } });
    await expect(service.updateMyPreference(member, { voiceId: 'gb-male' })).rejects.toThrow(BadRequestException);
    expect(users.updateVoicePreferences).not.toHaveBeenCalled();
  });
});
