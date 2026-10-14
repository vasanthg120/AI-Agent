import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiAlertTriangle, FiCheckCircle, FiKey, FiRefreshCw, FiStar, FiTrash2 } from 'react-icons/fi';
import { Badge, Button, CopyableText, EmptyState, Modal, Skeleton, Tabs } from '@/components/ui';
import { crmIntegrationsService, type CrmIntegration } from '@/services/crmIntegrationsService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { ErrorNotice, isLocalAddress, webhookAddress } from './CrmSetupWizard';
import { MappingEditor } from './MappingEditor';
import styles from './integrations.module.css';

const MODULE_TERM: Record<string, string> = { deals: 'deal', quotes: 'quote', contacts: 'contact', accounts: 'account' };
const plural = (word: string) => (/(s|x|ch|sh)$/i.test(word) ? `${word}es` : /[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);
const TRIGGER: Record<string, string> = { scheduled: 'Automatic', manual: 'Sync now', push: 'Received' };

const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

export const HEALTH: Record<string, { label: string; variant: 'success' | 'danger' | 'neutral' | 'accent' }> = {
  healthy: { label: 'Healthy', variant: 'success' },
  failing: { label: 'Needs attention', variant: 'danger' },
  not_synced: { label: 'Not synced yet', variant: 'neutral' },
  syncing: { label: 'Syncing…', variant: 'accent' },
};

interface Props {
  integration: CrmIntegration | null;
  onClose: () => void;
  // Opens the setup wizard again (new sign-in details).
  onReconnect: (integration: CrmIntegration) => void;
}

// Everything about one connected CRM: how it's doing, its sync history, its
// field mapping, and — for a CRM that sends records to HaiVE — the address
// and key it sends to.
export function CrmManageModal({ integration, onClose, onReconnect }: Props) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const provider = integration?.id ?? '';
  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['crm-integrations', 'history', provider],
    queryFn: () => crmIntegrationsService.history(provider),
    enabled: !!integration && tab === 'history',
  });

  if (!integration?.source) return null;
  const { source, label } = integration;
  const push = integration.connection === 'push';
  const termOf = (module: string) => plural(source.terminology[MODULE_TERM[module]] ?? module);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['crm-integrations'] });

  const close = () => {
    setTab('overview');
    setNewKey(null);
    onClose();
  };

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusy(null);
    }
  };

  const syncNow = () =>
    run('sync', async () => {
      const { result } = await crmIntegrationsService.syncNow(provider);
      if (result.status === 'error') toast.error(result.error ?? 'The sync didn’t finish.', { duration: 8_000 });
      else toast.success(`${label} is up to date`);
      await queryClient.invalidateQueries({ queryKey: ['crm-integrations', 'history', provider] });
    });

  const disconnect = () => {
    if (
      !window.confirm(
        `Disconnect ${label}? HaiVE stops ${push ? 'receiving' : 'syncing'} its records. What’s already here stays viewable, and you can reconnect at any time.`,
      )
    )
      return;
    void run('disconnect', async () => {
      await crmIntegrationsService.disconnect(provider);
      toast.success(`${label} disconnected`);
      close();
    });
  };

  const replaceKey = () => {
    if (!window.confirm(`Create a new key for ${label}? The current key stops working until you update it in your automation.`)) return;
    void run('key', async () => setNewKey((await crmIntegrationsService.rotateKey(provider)).webhookKey ?? null));
  };

  const health = HEALTH[source.health] ?? HEALTH.not_synced;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'mapping', label: 'Field mapping' },
    { id: 'history', label: push ? 'Activity' : 'Sync history' },
    ...(push ? [{ id: 'address', label: 'Address & key' }] : []),
  ];

  return (
    <Modal open onClose={close} title={label} description={integration.description} maxWidth={tab === 'mapping' ? 860 : 680}>
      <div className={styles.stack}>
        <Tabs items={tabs} activeId={tab} onChange={setTab} />

        {tab === 'overview' && (
          <>
            <div className={styles.statusRow}>
              <Badge variant={health.variant} dot>
                {integration.status === 'waiting' ? 'Waiting for first record' : health.label}
              </Badge>
              {source.isDefault && (
                <Badge variant="accent">
                  <FiStar aria-hidden /> Shown on dashboards
                </Badge>
              )}
            </div>

            {source.error && (
              <ErrorNotice error={source.error}>
                {source.error.kind === 'auth' && (
                  <Button type="button" size="sm" onClick={() => onReconnect(integration)}>
                    Reconnect
                  </Button>
                )}
                {source.error.kind === 'mapping' && (
                  <Button type="button" size="sm" onClick={() => setTab('mapping')}>
                    Review mapping
                  </Button>
                )}
                {!push && source.error.kind !== 'auth' && (
                  <Button type="button" size="sm" variant="secondary" loading={busy === 'sync'} onClick={() => void syncNow()}>
                    Retry
                  </Button>
                )}
              </ErrorNotice>
            )}

            <dl className={styles.facts}>
              <div>
                <dt>{push ? 'Last record received' : 'Last sync'}</dt>
                <dd>{source.lastSyncAt ? `${when(source.lastSyncAt)} (${formatRelativeTime(source.lastSyncAt)})` : 'Not yet'}</dd>
              </div>
              {!push && (
                <div>
                  <dt>Last successful sync</dt>
                  <dd>{source.lastSuccessAt ? when(source.lastSuccessAt) : 'Not yet'}</dd>
                </div>
              )}
              {Object.entries(source.records).map(([module, count]) => (
                <div key={module}>
                  <dt>{termOf(module)}</dt>
                  <dd>{count.toLocaleString()}</dd>
                </div>
              ))}
              <div>
                <dt>How it stays up to date</dt>
                <dd>{push ? `${label} sends each new record` : 'Automatically, every few minutes'}</dd>
              </div>
            </dl>

            {integration.setup.limitations.length > 0 && (
              <ul className={styles.noteList}>
                {integration.setup.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}

            <div className={styles.footer}>
              <Button type="button" variant="ghost" leftIcon={<FiTrash2 />} loading={busy === 'disconnect'} onClick={disconnect}>
                Disconnect
              </Button>
              {!source.isDefault && (
                <Button
                  type="button"
                  variant="ghost"
                  leftIcon={<FiStar />}
                  loading={busy === 'default'}
                  title="Dashboards show one CRM’s records — this one"
                  onClick={() =>
                    void run('default', async () => {
                      await crmIntegrationsService.makeDefault(provider);
                      toast.success(`Dashboards now show ${label}`);
                    })
                  }
                >
                  Show on dashboards
                </Button>
              )}
              {!push && (
                <>
                  <Button type="button" variant="secondary" onClick={() => onReconnect(integration)}>
                    Reconnect
                  </Button>
                  <Button type="button" leftIcon={<FiRefreshCw />} loading={busy === 'sync'} onClick={() => void syncNow()}>
                    Sync now
                  </Button>
                </>
              )}
            </div>
          </>
        )}

        {tab === 'mapping' && <MappingEditor sourceId={source.id} crmLabel={label} terminology={source.terminology} />}

        {tab === 'history' &&
          (historyLoading ? (
            <Skeleton height={160} />
          ) : !history || history.length === 0 ? (
            <EmptyState
              compact
              icon={FiRefreshCw}
              title={push ? 'Nothing received yet' : 'No syncs yet'}
              description={push ? `Records appear here as ${label} sends them.` : 'Each sync is listed here with what it brought in.'}
            />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Records</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((run_) => (
                    <tr key={run_.id}>
                      <td>{when(run_.startedAt)}</td>
                      <td>{TRIGGER[run_.trigger] ?? run_.trigger}</td>
                      <td>
                        {run_.processed.toLocaleString()} processed
                        {run_.failed > 0 && <span className={styles.muted}> · {run_.failed} skipped</span>}
                      </td>
                      <td>
                        {run_.status === 'ok' ? (
                          <span className={styles.okText}>
                            <FiCheckCircle aria-hidden /> Completed
                          </span>
                        ) : (
                          <details className={styles.details}>
                            <summary className={styles.failText}>
                              <FiAlertTriangle aria-hidden /> {run_.error ?? 'Didn’t finish'}
                            </summary>
                            {run_.errorDetail && <code className={styles.technical}>{run_.errorDetail}</code>}
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {tab === 'address' && source.webhook && (
          <>
            {newKey ? (
              <div className={styles.secretBox}>
                <strong>
                  <FiKey aria-hidden /> New key — copy it now, it won’t be shown again
                </strong>
                <CopyableText value={newKey} />
              </div>
            ) : (
              <p className={styles.note}>
                <FiKey aria-hidden /> Key {source.webhook.keyHint ? <code>{source.webhook.keyHint}</code> : 'created'} — only shown when it is
                created.
              </p>
            )}
            <div className={styles.addresses}>
              {Object.keys(source.webhook.paths).map((module) => (
                <div key={module}>
                  <span>Address for {termOf(module).toLowerCase()}</span>
                  <CopyableText value={webhookAddress(source.webhook!, module)} />
                </div>
              ))}
            </div>
            {Object.keys(source.webhook.paths).some((m) => isLocalAddress(webhookAddress(source.webhook!, m))) && (
              <p className={styles.problem}>
                <FiAlertTriangle aria-hidden /> This address only works on your own network, so {label} can’t reach it yet.
              </p>
            )}
            <ol className={styles.steps}>
              {(integration.setup.steps ?? []).map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ol>
            <div className={styles.footer}>
              <Button type="button" variant="secondary" leftIcon={<FiKey />} loading={busy === 'key'} onClick={replaceKey}>
                Replace key
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
