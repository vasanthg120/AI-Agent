import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { classifyDeviceType } from '../auth/session-meta.util';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { PushSubscribeDto, PushUnsubscribeDto } from './dto/push-subscribe.dto';
import { NotificationsService } from './notifications.service';
import { WebPushService } from './web-push.service';
import { PermissionExempt } from '../common/permissions/permission.decorator';

// Creation (POST /) is authenticated the same way every other route here
// is — no separate "service token" mechanism. python-agent mints a
// short-lived JWT for the target user (same pattern ChatService.
// generateSystemConversation already uses for the scheduled report job) and
// this controller can't tell that call apart from one a real user's own
// session made — by design, since a notification is always scoped to
// exactly the user named in the token's `sub`, never an arbitrary userId
// from the request body.
@UseGuards(JwtAuthGuard)
@PermissionExempt('personal')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private notificationsService: NotificationsService,
    private webPushService: WebPushService,
  ) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.list(user.sub);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateNotificationDto) {
    return this.notificationsService.create(user.sub, dto, user.organizationId);
  }

  @Post(':id/read')
  markRead(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.notificationsService.markRead(user.sub, id);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.markAllRead(user.sub);
  }

  @Get('preferences')
  getPreferences(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.getPreferences(user.sub, user.organizationId);
  }

  @Put('preferences')
  async updatePreferences(@CurrentUser() user: JwtPayload, @Body() dto: UpdateNotificationPreferencesDto) {
    await this.notificationsService.updatePreferences(user.sub, dto);
    return this.notificationsService.getPreferences(user.sub, user.organizationId);
  }

  // Public key is not a secret (it's embedded in every subscribe request by
  // design — that's how VAPID identifies this backend to the browser's push
  // service) but still requires a session, same as everything else in this
  // controller, simply because there's no reason for it not to.
  @Get('push/vapid-public-key')
  getVapidPublicKey() {
    return { publicKey: this.webPushService.getPublicKey() };
  }

  @Post('push/subscribe')
  async subscribePush(@CurrentUser() user: JwtPayload, @Body() dto: PushSubscribeDto, @Req() req: Request) {
    const userAgent = req.headers['user-agent'];
    await this.webPushService.subscribe(user.sub, {
      endpoint: dto.endpoint,
      keys: dto.keys,
      deviceType: classifyDeviceType(userAgent),
      userAgent,
      createdAt: new Date(),
      ...(dto.app ? { app: dto.app } : {}),
    });
    return { success: true };
  }

  @Post('push/unsubscribe')
  async unsubscribePush(@CurrentUser() user: JwtPayload, @Body() dto: PushUnsubscribeDto) {
    await this.webPushService.unsubscribe(user.sub, dto.endpoint);
    return { success: true };
  }
}
