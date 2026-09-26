import { useEffect, useState } from 'react';
import { FiBell } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Skeleton, Switch, Tooltip } from '@/components/ui';
import { notificationsService, type NotificationPreferences } from '@/services/notificationsService';
import { extractErrorMessage } from '@/utils/errors';
import { isPushSupported, subscribeToPush, unsubscribeFromPush } from '@/utils/webPush';
import { SettingsSection } from '../components/SettingsSection';

type Channel = 'desktopPush' | 'mobilePush' | 'email';

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingChannel, setSavingChannel] = useState<Channel | null>(null);
  const pushSupported = isPushSupported();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await notificationsService.getPreferences();
        if (!cancelled) setPrefs(data);
      } catch (err) {
        if (!cancelled) setLoadError(extractErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setChannel = async (channel: Channel, checked: boolean) => {
    if (!prefs || savingChannel) return;
    setSavingChannel(channel);
    const previous = prefs;
    try {
      // Push channels drive a real browser subscription, not just a stored
      // boolean — turning one on only persists the preference once the
      // browser permission/subscribe dance actually succeeds, so a denial
      // never leaves a preference on that the browser can't satisfy.
      // Turning one off persists first (stops future server-side delivery
      // immediately) then tears down the client-side subscription.
      if (channel !== 'email') {
        if (checked) {
          await subscribeToPush();
        } else {
          await unsubscribeFromPush();
        }
      }
      const updated = await notificationsService.updatePreferences({ [channel]: checked });
      setPrefs(updated);
      toast.success('Notification preferences updated');
    } catch (err) {
      setPrefs(previous);
      toast.error(extractErrorMessage(err));
    } finally {
      setSavingChannel(null);
    }
  };

  if (loading) {
    return (
      <SettingsSection
        icon={<FiBell />}
        title="Channels"
        description="Choose where you'd like to receive notifications."
      >
        <Skeleton height={20} />
        <Skeleton height={20} />
        <Skeleton height={20} />
      </SettingsSection>
    );
  }

  if (loadError || !prefs) {
    return (
      <SettingsSection
        icon={<FiBell />}
        title="Channels"
        description="Choose where you'd like to receive notifications."
      >
        <p>{loadError ?? 'Could not load notification preferences.'}</p>
      </SettingsSection>
    );
  }

  const desktopDisabled = savingChannel !== null || !prefs.orgPolicy.pushEnabled || !pushSupported;
  const mobileDisabled = desktopDisabled;
  const emailDisabled = savingChannel !== null || !prefs.orgPolicy.emailEnabled;

  const desktopSwitch = (
    <Switch
      checked={prefs.desktopPush}
      onChange={(checked) => void setChannel('desktopPush', checked)}
      label="Desktop notifications"
      description={
        pushSupported
          ? 'Real browser push notifications for new activity, delivered to this browser.'
          : 'Not supported in this browser.'
      }
      disabled={desktopDisabled}
    />
  );

  const mobileSwitch = (
    <Switch
      checked={prefs.mobilePush}
      onChange={(checked) => void setChannel('mobilePush', checked)}
      label="Mobile push notifications"
      description={
        pushSupported
          ? "Push notifications when you're using HaiVE from a mobile browser."
          : 'Not supported in this browser.'
      }
      disabled={mobileDisabled}
    />
  );

  const emailSwitch = (
    <Switch
      checked={prefs.email}
      onChange={(checked) => void setChannel('email', checked)}
      label="Email notifications"
      description="Important alerts and activity sent to your account email."
      disabled={emailDisabled}
    />
  );

  return (
    <SettingsSection icon={<FiBell />} title="Channels" description="Choose where you'd like to receive notifications.">
      {prefs.orgPolicy.pushEnabled ? (
        desktopSwitch
      ) : (
        <Tooltip content="Disabled by your organization">{desktopSwitch}</Tooltip>
      )}
      {prefs.orgPolicy.pushEnabled ? (
        mobileSwitch
      ) : (
        <Tooltip content="Disabled by your organization">{mobileSwitch}</Tooltip>
      )}
      {prefs.orgPolicy.emailEnabled ? (
        emailSwitch
      ) : (
        <Tooltip content="Disabled by your organization">{emailSwitch}</Tooltip>
      )}
    </SettingsSection>
  );
}
