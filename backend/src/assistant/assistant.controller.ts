import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Permission, PermissionExempt } from '../common/permissions/permission.decorator';
import { AssistantService } from './assistant.service';
import { ConversationSettingsService } from './conversation-settings.service';
import { UpdateConversationSettingsDto } from './dto/update-conversation-settings.dto';

// Haive's voice assistant. Everyone signed in has one: what it tells them is
// limited inside to what they may see (TeamScopeService), the way the Dashboard,
// Inbox and Agent Activity are — so no permission list takes it away.
@UseGuards(JwtAuthGuard)
@PermissionExempt('personal')
@Controller('assistant')
export class AssistantController {
  constructor(
    private assistant: AssistantService,
    private settings: ConversationSettingsService,
  ) {}

  /** Today's spoken briefing — written once (from the business's own data) and reused while nothing changes. */
  @Get('briefing')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  briefing(@CurrentUser() user: JwtPayload, @Query('slot') slot?: string, @Query('refresh') refresh?: string) {
    return this.assistant.briefing(user, { slot: slot && /^[a-z0-9_-]{1,64}$/i.test(slot) ? slot : 'login', refresh: refresh === 'true' });
  }

  /** It was spoken (or seen): it won't speak on its own again today. */
  @Post('briefing/:id/spoken')
  async spoken(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.assistant.markSpoken(user, id);
    return { ok: true };
  }

  /** "Do it": what Haive suggested in the briefing, done now — only ever on the person's own yes. */
  @Post('briefing/:id/actions/:actionId')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  runAction(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('actionId') actionId: string) {
    return this.assistant.runAction(user, id, actionId);
  }

  /** "Not now". */
  @Post('briefing/:id/actions/:actionId/dismiss')
  dismissAction(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('actionId') actionId: string) {
    return this.assistant.dismissAction(user, id, actionId);
  }

  // ---- AI Conversations settings: each person's own, and the company default ----

  @Get('settings')
  getSettings(@CurrentUser() user: JwtPayload) {
    return this.settings.view(user);
  }

  @Put('settings/me')
  updateMine(@CurrentUser() user: JwtPayload, @Body() dto: UpdateConversationSettingsDto) {
    return this.settings.updateMine(user, dto);
  }

  /** Back to the company default. */
  @Delete('settings/me')
  resetMine(@CurrentUser() user: JwtPayload) {
    return this.settings.resetMine(user);
  }

  /** The company default — owners and admins, like Voice & Accent's. */
  @Put('settings/organization')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  @Permission('settings', 'manage')
  updateOrganization(@CurrentUser() user: JwtPayload, @Body() dto: UpdateConversationSettingsDto) {
    return this.settings.updateOrganization(user, dto);
  }
}
