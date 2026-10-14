import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { FiAlertTriangle, FiInfo, FiKey } from 'react-icons/fi';
import { Button, CopyableText, Modal } from '@/components/ui';
import { timeAgo } from '@/components/data-sources/timeAgo';
import { MODULE_LABEL, type DataSourceAdminView, type MirroredModule } from '@/services/dataSourcesService';
import { isLocalAddress, webhookUrl, zapierService, type WebhookInfo } from '@/services/zapierService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './ZapierModal.module.css';

const MODULES: MirroredModule[] = ['contacts', 'deals', 'accounts'];

/** Where a webhook source receives records and how to point a Zap at it. The
 * key is only passed right after it was created or replaced. */
export function WebhookDetails({
  label,
  webhook,
  secretKey,
}: {
  label: string;
  webhook: WebhookInfo;
  secretKey?: string;
}) {
  const modules = MODULES.filter((m) => webhook.paths[m]);
  const local = modules.some((m) => isLocalAddress(webhookUrl(webhook, m)));
  return (
    <div className={styles.stack}>
      {secretKey ? (
        <div className={styles.secret}>
          <strong>
            <FiKey aria-hidden /> Webhook key — copy it now, it won’t be shown again
          </strong>
          <CopyableText value={secretKey} />
        </div>
      ) : (
        webhook.keyHint && (
          <p className={styles.note}>
            <FiKey aria-hidden /> Key <code>{webhook.keyHint}</code> — lost it? Replace the key below and update the
            Zap.
          </p>
        )
      )}

      <div className={styles.urls}>
        {modules.map((m) => (
          <div key={m}>
            <span>{MODULE_LABEL[m]}</span>
            <CopyableText value={webhookUrl(webhook, m)} />
          </div>
        ))}
      </div>
      {local && (
        <p className={styles.warning}>
          <FiAlertTriangle aria-hidden /> This address is only reachable on your own network, so Zapier can’t post to
          it. Set PUBLIC_API_BASE_URL on the server to HaiVE’s public address (or a tunnel in development).
        </p>
      )}

      <ol className={styles.steps}>
        <li>
          In Zapier create a Zap. <strong>Trigger:</strong> {label} — the event for new records (e.g.{' '}
          <em>New Customer</em> or <em>New Job</em>).
        </li>
        <li>
          <strong>Action:</strong> Webhooks by Zapier → <em>POST</em>. URL: the address above for that kind of record.
          Payload type: <em>json</em>.
        </li>
        <li>
          <strong>Data:</strong> add the fields you want in HaiVE — always include the record’s <em>id</em>, plus name,
          email, phone, value, status…
        </li>
        <li>
          <strong>Headers:</strong> <code>X-HaiVE-Key</code> = the webhook key.
        </li>
        <li>
          Test the step, then turn the Zap on. The first record sets up the field mapping, which you can adjust under
          Configure.
        </li>
      </ol>
    </div>
  );
}

// A Zapier-fed data source: its addresses, key replacement and disconnecting.
export function WebhookSourceModal({ source, onClose }: { source: DataSourceAdminView | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  const close = () => {
    setNewKey(null);
    onClose();
  };

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['data-sources'] });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!source?.webhook) return null;
  const active = source.status === 'active';

  const rotate = () => {
    if (
      !window.confirm(
        `Replace ${source.label}’s webhook key? Zaps using the old key stop working until you paste in the new one.`,
      )
    )
      return;
    void run('rotate', async () => {
      setNewKey((await zapierService.rotateWebhookKey(source.id)).key);
      toast.success(active ? 'New key created' : `${source.label} reconnected with a new key`);
    });
  };

  const disconnect = () => {
    if (!window.confirm(`Stop receiving records from ${source.label}? What was already received stays viewable.`))
      return;
    void run('disconnect', async () => {
      await zapierService.disconnectWebhookSource(source.id);
      toast.success(`${source.label} disconnected`);
      close();
    });
  };

  return (
    <Modal
      open
      onClose={close}
      title={`${source.label} via Zapier`}
      description={
        source.webhook.lastReceivedAt
          ? `${source.webhook.received} records received · last ${timeAgo(source.webhook.lastReceivedAt)}`
          : 'Nothing received yet.'
      }
      maxWidth={640}
    >
      {active || newKey ? (
        <WebhookDetails label={source.label} webhook={source.webhook} secretKey={newKey ?? undefined} />
      ) : (
        <p className={styles.note}>
          <FiInfo aria-hidden /> Disconnected — HaiVE refuses records sent to it. Create a new key to start receiving
          again.
        </p>
      )}
      <div className={styles.actions}>
        {active && (
          <Button type="button" variant="ghost" loading={busy === 'disconnect'} onClick={disconnect}>
            Disconnect
          </Button>
        )}
        <Button type="button" variant="secondary" leftIcon={<FiKey />} loading={busy === 'rotate'} onClick={rotate}>
          {active ? 'Replace key' : 'Reconnect with a new key'}
        </Button>
        <Button type="button" onClick={close}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
