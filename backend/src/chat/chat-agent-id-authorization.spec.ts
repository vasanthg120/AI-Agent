import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';

// An 'agent_user' account exists to BE one specific persona (user.assignedAgentId) —
// chat.service.ts's listAgents() already only ever shows it that one option in the
// @mention list, but that was always a UI convenience, never enforcement: nothing
// previously stopped a direct POST /chat/messages with a different dto.agentId from
// overriding it, which would hand that connection a different persona's (potentially
// unrestricted) allowedTools/system prompt instead of the one it was actually granted.
// This spec covers the fix: sendMessage() now forces agentId to the account's own
// assignedAgentId for a locked agent_user, ignoring any client-supplied dto.agentId —
// while leaving every other role's dto.agentId untouched (AgentRole.assignedDepartments/
// assignedUserIds are documented as @mention visibility only, not a security boundary).
describe('ChatController — agentId cannot be overridden by a locked agent_user account', () => {
  const basePayload: JwtPayload = {
    sub: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
    aiAccessEnabled: true,
  } as JwtPayload;

  function makeController() {
    const chatService = {
      sendMessage: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as jest.Mocked<ChatService>;
    const controller = new ChatController(chatService);
    return { controller, chatService };
  }

  function fakeRequest() {
    return { headers: { authorization: 'Bearer test-token' } } as any;
  }

  // sendMessage(userId, organizationId, bearerToken, message, conversationId, agentId, attachmentIds)
  function calledAgentId(chatService: jest.Mocked<ChatService>): unknown {
    return (chatService.sendMessage as jest.Mock).mock.calls[0][5];
  }

  it('ignores a client-supplied agentId for a locked agent_user account, using its own assignedAgentId instead', () => {
    const { controller, chatService } = makeController();
    const user: JwtPayload = { ...basePayload, roles: ['agent_user'], assignedAgentId: 'restricted-bot' };

    controller.sendMessage(user, fakeRequest(), { message: 'hi', agentId: 'some-other-persona' } as any);

    expect(calledAgentId(chatService)).toBe('restricted-bot');
  });

  it('still defaults to assignedAgentId for a locked agent_user account when no agentId is supplied', () => {
    const { controller, chatService } = makeController();
    const user: JwtPayload = { ...basePayload, roles: ['agent_user'], assignedAgentId: 'restricted-bot' };

    controller.sendMessage(user, fakeRequest(), { message: 'hi' } as any);

    expect(calledAgentId(chatService)).toBe('restricted-bot');
  });

  it('honors a client-supplied agentId when the account also has admin (admin wins over the agent_user lock)', () => {
    const { controller, chatService } = makeController();
    const user: JwtPayload = { ...basePayload, roles: ['agent_user', 'admin'], assignedAgentId: 'restricted-bot' };

    controller.sendMessage(user, fakeRequest(), { message: 'hi', agentId: 'any-persona' } as any);

    expect(calledAgentId(chatService)).toBe('any-persona');
  });

  it.each([['user'], ['manager'], ['consultant'], ['owner'], ['admin']])(
    'honors a client-supplied agentId unchanged for role %s',
    (role) => {
      const { controller, chatService } = makeController();
      const user: JwtPayload = { ...basePayload, roles: [role] };

      controller.sendMessage(user, fakeRequest(), { message: 'hi', agentId: 'any-persona' } as any);

      expect(calledAgentId(chatService)).toBe('any-persona');
    },
  );

  it('leaves agentId undefined for a non-agent_user role with no agentId supplied (unchanged default behavior)', () => {
    const { controller, chatService } = makeController();
    const user: JwtPayload = { ...basePayload, roles: ['user'] };

    controller.sendMessage(user, fakeRequest(), { message: 'hi' } as any);

    expect(calledAgentId(chatService)).toBeUndefined();
  });
});
