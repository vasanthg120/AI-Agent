import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiCheckCircle, FiInfo, FiKey, FiMapPin } from 'react-icons/fi';
import { Button, Input, Modal } from '@/components/ui';
import { gorillaDashService } from '@/services/gorillaDashService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './ConnectGorillaDashModal.module.css';

// Connect (or disconnect) Gorilla Dash. The key and secret are checked with
// Gorilla Dash before they're saved; once connected, its enquiries and people
// sync into their own data source and the AI's Gorilla Dash tools work.
export function ConnectGorillaDashModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: status, refetch } = useQuery({
    queryKey: ['gorilladash', 'status'],
    queryFn: gorillaDashService.getStatus,
    enabled: open,
  });
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshAll = () =>
    Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: ['data-sources'] }),
      queryClient.invalidateQueries({ queryKey: ['integrations'] }),
    ]);

  const connect = async () => {
    setBusy(true);
    try {
      const result = await gorillaDashService.connect(apiKey.trim(), apiSecret.trim());
      setApiKey('');
      setApiSecret('');
      toast.success(
        result.keyScope === 'location'
          ? 'Gorilla Dash connected with a location key — the first sync has started.'
          : 'Gorilla Dash connected — the first sync has started.',
      );
      await refreshAll();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (
      !window.confirm(
        'Disconnect Gorilla Dash? Its synced data stays viewable as a disconnected source, and the AI loses access.',
      )
    )
      return;
    setBusy(true);
    try {
      await gorillaDashService.disconnect();
      toast.success('Gorilla Dash disconnected');
      await refreshAll();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Gorilla Dash"
      description="Enquiries and people from Gorilla Dash, kept as their own data source."
      maxWidth={520}
    >
      {status?.connected ? (
        <div className={styles.stack}>
          <div className={styles.connected}>
            <FiCheckCircle aria-hidden />
            <div>
              <strong>Connected</strong>
              <span>
                Key <code>{status.keyMasked}</code>
                {status.keyScope === 'organization' && ' · organisation key (every location)'}
                {status.keyScope === 'location' && ' · location key (one location only)'}
              </span>
            </div>
          </div>
          {status.keyScope === 'location' && (
            <p className={styles.note}>
              <FiMapPin aria-hidden /> A location key only sees its own location’s enquiries and can’t search other
              locations. Use an organisation key to see everything.
            </p>
          )}
          <div className={styles.actions}>
            <Button type="button" variant="outline" loading={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className={styles.stack}
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <Input
            label="API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            leftIcon={<FiKey />}
          />
          <Input
            label="API secret"
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            autoComplete="new-password"
            leftIcon={<FiKey />}
          />
          <p className={styles.note}>
            <FiInfo aria-hidden /> Find both in Gorilla Dash’s API settings. An <strong>organisation key</strong> sees
            every location; a <strong>location key</strong> sees only its own. HaiVE checks the pair with Gorilla Dash
            before saving it, stores it encrypted, and never shows it again.
          </p>
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={apiKey.trim().length < 8 || apiSecret.trim().length < 8}>
              Connect Gorilla Dash
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
