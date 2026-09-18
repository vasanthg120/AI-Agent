import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ChatGateway } from '../chat/chat.gateway';
import { MailService } from '../mail/mail.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { Notification, NotificationDocument } from './schemas/notification.schema';
import { WebPushService } from './web-push.service';

const DEFAULT_PREFS = { desktopPush: true, mobilePush: true, email: true };
const DEFAULT_POLICY = { emailEnabled: true, pushEnabled: true };

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name) private notificationModel: Model<NotificationDocument>,
    private chatGateway: ChatGateway,
    private usersService: UsersService,
    private organizationsService: OrganizationsService,
    private mailService: MailService,
    private webPushService: WebPushService,
  ) {}

  async create(userId: string, dto: CreateNotificationDto, organizationId?: string) {
    const notification = await this.notificationModel.create({ userId, organizationId, ...dto });
    // Live push if they're connected right now (ChatGateway.emitToUser) — a
    // no-op otherwise; GET /notifications below is the source of truth for
    // anyone who missed the live event.
    this.chatGateway.emitToUser(userId, 'notification', notification);
    // Not awaited — a slow/failed email or push send must never delay or
    // fail the request that triggered this notification (matches every
    // other fire-and-forget side effect in this codebase, e.g.
    // MailService's own send()).
    void this.dispatchExternalChannels(userId, organizationId, notification);
    return notification;
  }

  // The single place real delivery-channel dispatch happens — every one of
  // the 5 real call sites into create() (finance docs, late reports,
  // gamification, email-intelligence x2) and the manual POST /notifications
  // endpoint (including python-agent's own notify() client) automatically
  // gains real email/push delivery through this one method, with zero
  // changes needed at any of those call sites.
  private async dispatchExternalChannels(
    userId: string,
    organizationId: string | undefined,
    notification: NotificationDocument,
  ): Promise<void> {
    try {
      const email = await this.resolveEmailRecipient(userId, organizationId);
      if (email) {
        void this.mailService.sendNotificationEmail(email, notification.title, notification.description);
      }
      const user = await this.usersService.findById(userId);
      if (!user) return;
      const orgPolicy = organizationId
        ? await this.organizationsService.getNotificationPolicy(organizationId)
        : DEFAULT_POLICY;
      const prefs = user.notificationPreferences ?? DEFAULT_PREFS;
      if ((prefs.desktopPush || prefs.mobilePush) && orgPolicy.pushEnabled) {
        void this.webPushService.sendToUser(
          userId,
          { title: notification.title, body: notification.description },
          { allowDesktop: prefs.desktopPush, allowMobile: prefs.mobilePush },
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to dispatch external notification channels: ${(err as Error).message}`);
    }
  }

  /** Extracted from dispatchExternalChannels' own inline check (same
   * behavior, not a new policy) so a caller that needs to send something
   * other than the generic notification-email template (e.g.
   * store-settings.service.ts's EOD report email) can reuse the exact same
   * "is this user actually eligible for email" decision instead of
   * duplicating the preference/policy lookup. Returns the user's email only
   * when both the user's own preference and the org's policy allow it —
   * null otherwise (no connection, no email set, or opted out). */
  async resolveEmailRecipient(userId: string, organizationId?: string): Promise<string | null> {
    const user = await this.usersService.findById(userId);
    if (!user) return null;
    const orgPolicy = organizationId ? await this.organizationsService.getNotificationPolicy(organizationId) : DEFAULT_POLICY;
    const prefs = user.notificationPreferences ?? DEFAULT_PREFS;
    return prefs.email && orgPolicy.emailEnabled ? user.email : null;
  }

  list(userId: string) {
    return this.notificationModel.find({ userId }).sort({ createdAt: -1 }).limit(50).exec();
  }

  async markRead(userId: string, id: string) {
    await this.notificationModel.updateOne({ _id: id, userId }, { read: true }).exec();
  }

  async markAllRead(userId: string) {
    await this.notificationModel.updateMany({ userId, read: false }, { read: true }).exec();
  }

  async getPreferences(
    userId: string,
    organizationId: string | undefined,
  ): Promise<{ desktopPush: boolean; mobilePush: boolean; email: boolean; orgPolicy: { emailEnabled: boolean; pushEnabled: boolean } }> {
    const user = await this.usersService.findById(userId);
    const orgPolicy = organizationId
      ? await this.organizationsService.getNotificationPolicy(organizationId)
      : DEFAULT_POLICY;
    return { ...(user?.notificationPreferences ?? DEFAULT_PREFS), orgPolicy };
  }

  async updatePreferences(userId: string, patch: UpdateNotificationPreferencesDto) {
    await this.usersService.updateNotificationPreferences(userId, patch);
  }
}
