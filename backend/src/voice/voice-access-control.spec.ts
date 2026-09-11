import { ForbiddenException } from '@nestjs/common';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { JwtPayload } from '../auth/jwt-payload.interface';

// Voice access is a provider/model-availability control, NOT an AI on/off
// switch (see user.schema.ts's voiceAccessEnabled comment) — this spec only
// covers the one thing that actually matters for that distinction: a user
// with voiceAccessEnabled:false must be rejected BEFORE VoiceService (the
// thing that actually calls python-agent/Sarvam) is ever invoked, so no LLM
// call and no billing reservation ever happens for a blocked request.
describe('VoiceController — per-user voice access control', () => {
  const basePayload: JwtPayload = {
    sub: 'user-1',
    email: 'user@example.com',
    roles: ['user'],
    organizationId: 'org-1',
  };

  function makeController() {
    const voiceService = {
      transcribe: jest.fn(),
      speak: jest.fn(),
    } as unknown as jest.Mocked<VoiceService>;
    const controller = new VoiceController(voiceService);
    return { controller, voiceService };
  }

  it('rejects transcribe with 403 and never calls VoiceService when voiceAccessEnabled is false', () => {
    const { controller, voiceService } = makeController();
    const user: JwtPayload = { ...basePayload, voiceAccessEnabled: false };
    const file = { buffer: Buffer.from('x') } as Express.Multer.File;

    expect(() => controller.transcribe(user, file, 'en')).toThrow(ForbiddenException);
    expect(voiceService.transcribe).not.toHaveBeenCalled();
  });

  it('rejects speak with 403 and never calls VoiceService when voiceAccessEnabled is false', async () => {
    const { controller, voiceService } = makeController();
    const user: JwtPayload = { ...basePayload, voiceAccessEnabled: false };
    const res = { set: jest.fn(), send: jest.fn() } as any;

    await expect(controller.speak(user, { text: 'hi', languageCode: 'en' } as any, res)).rejects.toThrow(
      ForbiddenException,
    );
    expect(voiceService.speak).not.toHaveBeenCalled();
  });

  it('allows transcribe through to VoiceService when voiceAccessEnabled is true', () => {
    const { controller, voiceService } = makeController();
    const user: JwtPayload = { ...basePayload, voiceAccessEnabled: true };
    const file = { buffer: Buffer.from('x') } as Express.Multer.File;
    (voiceService.transcribe as jest.Mock).mockResolvedValue({ transcript: 'hi', languageCode: 'en' });

    controller.transcribe(user, file, 'en');
    expect(voiceService.transcribe).toHaveBeenCalledWith('org-1', 'user-1', file, 'en');
  });

  it('treats voiceAccessEnabled undefined as allowed (only an explicit false blocks)', () => {
    const { controller, voiceService } = makeController();
    const user: JwtPayload = { ...basePayload, voiceAccessEnabled: undefined };
    const file = { buffer: Buffer.from('x') } as Express.Multer.File;
    (voiceService.transcribe as jest.Mock).mockResolvedValue({ transcript: 'hi', languageCode: 'en' });

    expect(() => controller.transcribe(user, file, 'en')).not.toThrow();
    expect(voiceService.transcribe).toHaveBeenCalled();
  });
});
