import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { UsersService } from '../users/users.service';
import { WebPushService } from './web-push.service';

jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn(async () => ({ statusCode: 201 })) }));

// Which subscriptions a message goes to: HaiVE's own notifications never reach
// the Dialer's subscription, and the Dialer's "report ready" reaches nothing else.
describe('WebPushService — HaiVE vs the Dialer', () => {
  const sub = (endpoint: string, deviceType: 'desktop' | 'mobile', app?: 'dialer') => ({
    endpoint,
    keys: { p256dh: 'p', auth: 'a' },
    deviceType,
    createdAt: new Date(),
    ...(app ? { app } : {}),
  });
  const user = {
    pushSubscriptions: [sub('https://push/desktop', 'desktop'), sub('https://push/phone', 'mobile'), sub('https://push/dialer', 'mobile', 'dialer')],
  };
  const sent = () => (webpush.sendNotification as jest.Mock).mock.calls.map(([target]) => target.endpoint).sort();
  let service: WebPushService;
  let removed: jest.Mock;

  beforeEach(() => {
    (webpush.sendNotification as jest.Mock).mockClear();
    removed = jest.fn();
    const config = { get: (key: string) => ({ 'webPush.publicKey': 'pub', 'webPush.privateKey': 'priv', 'webPush.subject': 'mailto:x@y.z' })[key] } as unknown as ConfigService;
    const users = { findById: async () => user, removePushSubscription: removed } as unknown as UsersService;
    service = new WebPushService(config, users);
  });

  it("HaiVE's notifications go to its own subscriptions only, as the device toggles allow", async () => {
    await service.sendToUser('u1', { title: 'Quote approved', body: 'x' }, { allowDesktop: true, allowMobile: true });
    expect(sent()).toEqual(['https://push/desktop', 'https://push/phone']);
    (webpush.sendNotification as jest.Mock).mockClear();
    await service.sendToUser('u1', { title: 'x', body: 'x' }, { allowDesktop: false, allowMobile: true });
    expect(sent()).toEqual(['https://push/phone']);
  });

  it("the Dialer's message reaches the Dialer only, with where to open", async () => {
    await service.sendToApp('u1', 'dialer', { title: 'Your call report is ready', body: 'Score 7.5/10.', url: '/dialer/report/session/s1' });
    expect(sent()).toEqual(['https://push/dialer']);
    const [, body] = (webpush.sendNotification as jest.Mock).mock.calls[0];
    expect(JSON.parse(body)).toEqual({ title: 'Your call report is ready', body: 'Score 7.5/10.', url: '/dialer/report/session/s1' });
  });

  it('forgets a Dialer subscription the browser says is gone', async () => {
    (webpush.sendNotification as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await service.sendToApp('u1', 'dialer', { title: 't', body: 'b' });
    expect(removed).toHaveBeenCalledWith('u1', 'https://push/dialer');
  });
});
