import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ChatService } from './chat.service';
import { RenameConversationDto } from './dto/rename-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SetConversationFlagDto } from './dto/set-conversation-flag.dto';

// Tighter than the app-wide default (see ThrottlerModule.forRoot in
// app.module.ts) — every message here is a real, billed LLM call
// (chat.service.ts -> python-agent), so this route's ceiling is its own
// direct spend control, not just abuse prevention.
const CHAT_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Get('agents')
  listAgents(@CurrentUser() user: JwtPayload) {
    return this.chatService.listAgents(user);
  }

  @Get('conversations')
  listConversations(@CurrentUser() user: JwtPayload) {
    return this.chatService.listConversations(user.sub);
  }

  @Get('conversations/:id')
  getConversation(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chatService.getConversation(user.sub, id);
  }

  @Patch('conversations/:id')
  async renameConversation(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RenameConversationDto) {
    await this.chatService.renameConversation(user.sub, id, dto.title);
    return { status: 'ok' };
  }

  @Patch('conversations/:id/flag')
  async setConversationFlag(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetConversationFlagDto) {
    await this.chatService.setConversationFlag(user.sub, id, dto.flag, dto.value);
    return { status: 'ok' };
  }

  @Delete('conversations/:id')
  async deleteConversation(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.chatService.deleteConversation(user.sub, id);
    return { status: 'ok' };
  }

  @Post('messages')
  @Throttle(CHAT_THROTTLE)
  sendMessage(@CurrentUser() user: JwtPayload, @Req() req: Request, @Body() dto: SendMessageDto) {
    this.assertAiAccessAllowed(user);
    const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    // agent_user accounts only ever see one agent in the mention list anyway
    // — default new conversations to it so they don't need to @mention.
    const agentId = dto.agentId ?? (user.roles.includes('agent_user') ? user.assignedAgentId : undefined);
    return this.chatService.sendMessage(user.sub, user.organizationId, bearerToken, dto.message, dto.conversationId, agentId);
  }

  // The organization purchased the AI credits; this is the per-employee
  // on/off switch (see user.schema.ts's aiAccessEnabled comment) — checked
  // BEFORE chatService.sendMessage (which is what actually reaches
  // python-agent and reserves credits against the org wallet), so a blocked
  // request never makes an LLM call and never spends anything. Same shape
  // as VoiceController.assertVoiceAllowed: user.aiAccessEnabled is undefined
  // only for special-purpose tokens (2FA challenge, OAuth state) that can't
  // reach this guard anyway (JwtAuthGuard rejects them first); for every
  // real session/API-token request it's always a live boolean refreshed
  // from the User document on this exact request (see JwtStrategy.validate()).
  private assertAiAccessAllowed(user: JwtPayload): void {
    if (user.aiAccessEnabled === false) {
      throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    }
  }
}
