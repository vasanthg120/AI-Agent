import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ChatGateway } from '../chat/chat.gateway';
import { MailService } from '../mail/mail.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { NotificationsService } from './notifications.service';
import { Notification } from './schemas/notification.schema';
import { WebPushService } from './web-push.service';

// Haive reaching out: the bell and/or a push, never an email — and "pushed" only
// when a push could really reach one of the person's devices.
describe('NotificationsService.notifyAssistant', () => {
  const phone = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' }, deviceType: 'mobile' };
  const message = { title: '3 new enquiries are waiting · T.Nagar', body: 'No reply for over 2 hours.', slot: 'a-enquiries-b1', kind: 'warning' as const };

  function build(opts: { pushEnabled?: boolean; subscriptions?: unknown[]; mobilePush?: boolean; orgPush?: boolean } = {}) {
    const created: Record<string, unknown>[] = [];
    const sendToUser = jest.fn(async () => undefined);
    const emitToUser = jest.fn();
    const sendNotificationEmail = jest.fn();
    const user = { email: 'o@example.com', pushSubscriptions: opts.subscriptions ?? [phone], notificationPreferences: { desktopPush: true, mobilePush: opts.mobilePush ?? true, email: true } };
    return Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getModelToken(Notification.name), useValue: { create: async (doc: Record<string, unknown>) => (created.push(doc), doc) } },
        { provide: ChatGateway, useValue: { emitToUser } },
        { provide: UsersService, useValue: { findById: async () => user } },
        { provide: OrganizationsService, useValue: { getNotificationPolicy: async () => ({ emailEnabled: true, pushEnabled: opts.orgPush ?? true }) } },
        { provide: MailService, useValue: { sendNotificationEmail } },
        { provide: WebPushService, useValue: { enabled: opts.pushEnabled ?? true, sendToUser } },
      ],
    })
      .compile()
      .then((m) => ({ service: m.get(NotificationsService), created, sendToUser, emitToUser, sendNotificationEmail }));
  }

  it('bell and push: a Haive notification that opens the briefing, the push linking to it — and no email', async () => {
    const t = await build();
    await expect(t.service.notifyAssistant('u1', 'org-1', message, { bell: true, phone: true })).resolves.toEqual({ bell: true, push: true });
    expect(t.created[0]).toMatchObject({ userId: 'u1', source: 'haive', kind: 'warning', entityType: 'assistantBriefing', entityId: 'a-enquiries-b1' });
    expect(t.emitToUser).toHaveBeenCalledWith('u1', 'notification', expect.objectContaining({ title: message.title }));
    expect(t.sendToUser).toHaveBeenCalledWith('u1', { title: message.title, body: message.body, url: '/dashboard?haive=a-enquiries-b1' }, { allowDesktop: true, allowMobile: true });
    expect(t.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('not counted as pushed when it couldn’t reach anything: push not set up, no device, phone pushes off, or the organization turned push off', async () => {
    for (const opts of [{ pushEnabled: false }, { subscriptions: [] }, { mobilePush: false }, { orgPush: false }]) {
      const t = await build(opts);
      await expect(t.service.notifyAssistant('u1', 'org-1', message, { bell: false, phone: true })).resolves.toEqual({ bell: false, push: false });
      expect(t.sendToUser).not.toHaveBeenCalled();
    }
  });

  it('bell off: nothing in the bell list', async () => {
    const t = await build();
    await t.service.notifyAssistant('u1', 'org-1', message, { bell: false, phone: true });
    expect(t.created).toHaveLength(0);
  });
});
