import { Test } from '@nestjs/testing';
import { ChatGateway } from '../chat/chat.gateway';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { WebPushService } from './web-push.service';
import { NotificationsService } from './notifications.service';
import { MailService } from '../mail/mail.service';
import { getModelToken } from '@nestjs/mongoose';
import { Notification } from './schemas/notification.schema';

// Unit test for resolveEmailRecipient — extracted (not duplicated) from
// dispatchExternalChannels' existing inline check so store-settings.service.ts
// can reuse the exact same eligibility decision for the new EOD report email
// without re-implementing the preference/policy lookup. Confirms the
// refactor preserved the original behavior for every combination.
describe('NotificationsService.resolveEmailRecipient', () => {
  const buildService = (user: { email: string; notificationPreferences?: { email: boolean } } | null, orgPolicy: { emailEnabled: boolean }) =>
    Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getModelToken(Notification.name), useValue: {} },
        { provide: ChatGateway, useValue: {} },
        { provide: UsersService, useValue: { findById: async () => user } },
        { provide: OrganizationsService, useValue: { getNotificationPolicy: async () => orgPolicy } },
        { provide: MailService, useValue: {} },
        { provide: WebPushService, useValue: {} },
      ],
    })
      .compile()
      .then((moduleRef) => moduleRef.get(NotificationsService));

  it('returns the email when both the user preference and org policy allow it', async () => {
    const service = await buildService({ email: 'user@example.com', notificationPreferences: { email: true } }, { emailEnabled: true });
    await expect(service.resolveEmailRecipient('user-1', 'org-1')).resolves.toBe('user@example.com');
  });

  it('returns null when the user opted out, even if the org policy allows it', async () => {
    const service = await buildService({ email: 'user@example.com', notificationPreferences: { email: false } }, { emailEnabled: true });
    await expect(service.resolveEmailRecipient('user-1', 'org-1')).resolves.toBeNull();
  });

  it('returns null when the org policy disables email, even if the user opted in', async () => {
    const service = await buildService({ email: 'user@example.com', notificationPreferences: { email: true } }, { emailEnabled: false });
    await expect(service.resolveEmailRecipient('user-1', 'org-1')).resolves.toBeNull();
  });

  it('returns null when the user does not exist', async () => {
    const service = await buildService(null, { emailEnabled: true });
    await expect(service.resolveEmailRecipient('missing-user', 'org-1')).resolves.toBeNull();
  });
});
