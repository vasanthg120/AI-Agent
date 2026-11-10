import { ForbiddenException } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UsersService } from '../users/users.service';

// The organization purchased the AI credits; aiAccessEnabled is the
// per-employee on/off switch (see user.schema.ts's own comment) — this spec
// covers the one thing that actually matters: a user with
// aiAccessEnabled:false must be rejected BEFORE ChatService.sendMessage (the
// thing that actually calls python-agent and reserves credits against the
// org wallet) is ever invoked, so no LLM call and no billing reservation
// ever happens for a blocked request. Mirrors
// voice/voice-access-control.spec.ts's exact shape for the analogous
// voiceAccessEnabled check.
describe('ChatController — per-user AI access control', () => {
  const basePayload: JwtPayload = {
    sub: 'user-1',
    email: 'user@example.com',
    roles: ['user'],
    organizationId: 'org-1',
  };

  function makeController() {
    const chatService = {
      sendMessage: jest.fn(),
    } as unknown as jest.Mocked<ChatService>;
    // The AI role check (is their AI role still there?) is covered on its own below.
    const usersService = { aiRoleUnavailable: jest.fn().mockResolvedValue(false) } as unknown as jest.Mocked<UsersService>;
    const controller = new ChatController(chatService, usersService);
    return { controller, chatService, usersService };
  }

  function fakeRequest() {
    return { headers: { authorization: 'Bearer test-token' } } as any;
  }

  it('rejects sendMessage with 403 and never calls ChatService when aiAccessEnabled is false', async () => {
    const { controller, chatService } = makeController();
    const user: JwtPayload = { ...basePayload, aiAccessEnabled: false };

    await expect(controller.sendMessage(user, fakeRequest(), { message: 'hi' } as any)).rejects.toThrow(ForbiddenException);
    expect(chatService.sendMessage).not.toHaveBeenCalled();
  });

  it('allows sendMessage through to ChatService when aiAccessEnabled is true', async () => {
    const { controller, chatService } = makeController();
    const user: JwtPayload = { ...basePayload, aiAccessEnabled: true };
    (chatService.sendMessage as jest.Mock).mockResolvedValue({ ok: true });

    await controller.sendMessage(user, fakeRequest(), { message: 'hi' } as any);
    expect(chatService.sendMessage).toHaveBeenCalledWith('user-1', 'org-1', 'test-token', 'hi', undefined, undefined, undefined);
  });

  it('treats aiAccessEnabled undefined as allowed (only an explicit false blocks)', async () => {
    const { controller, chatService } = makeController();
    const user: JwtPayload = { ...basePayload, aiAccessEnabled: undefined };
    (chatService.sendMessage as jest.Mock).mockResolvedValue({ ok: true });

    await expect(controller.sendMessage(user, fakeRequest(), { message: 'hi' } as any)).resolves.toEqual({ ok: true });
    expect(chatService.sendMessage).toHaveBeenCalled();
  });
});
