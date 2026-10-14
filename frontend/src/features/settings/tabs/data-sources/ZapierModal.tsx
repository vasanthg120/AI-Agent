import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiAlertTriangle, FiCheckCircle, FiInfo, FiKey, FiPlus, FiRefreshCw, FiZap } from 'react-icons/fi';
import { Badge, Button, Input, Modal } from '@/components/ui';
import { timeAgo } from '@/components/data-sources/timeAgo';
import type { DataSourceAdminView, MirroredModule } from '@/services/dataSourcesService';
import { zapierService, type WebhookSourceCreated } from '@/services/zapierService';
import { extractErrorMessage } from '@/utils/errors';
import { WebhookDetails } from './WebhookSourceModal';
import styles from './ZapierModal.module.css';

const RECORD_KINDS: { module: MirroredModule; label: string; example: string }[] = [
  { module: 'contacts', label: 'Customers / contacts', example: 'e.g. Hoops “New Customer”' },
  { module: 'deals', label: 'Jobs / deals / leads', example: 'e.g. Hoops “New Job”' },
  { module: 'accounts', label: 'Companies', example: 'businesses or accounts' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  webhookSources: DataSourceAdminView[];
  onOpenSource: (id: string) => void;
}

// Settings → Data Sources → Zapier. Two independent parts:
//  1. AI actions — the organization's Zapier MCP server, so the AI can list
//     what each connected app (Hoops, Gorilla Dash, …) offers and run the
//     enabled actions (writes only after the person confirms);
//  2. New records — an app's Zap trigger posts each new record to HaiVE,
//     where the app becomes its own data source.
export function ZapierModal({ open, onClose, webhookSources, onOpenSource }: Props) {
  const queryClient = useQueryClient();
  const { data: status, refetch } = useQuery({
    queryKey: ['zapier', 'status'],
    queryFn: zapierService.getStatus,
    enabled: open,
  });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [modules, setModules] = useState<MirroredModule[]>(['contacts', 'deals']);
  const [dealTerm, setDealTerm] = useState('');
  const [contactTerm, setContactTerm] = useState('');
  const [created, setCreated] = useState<(WebhookSourceCreated & { label: string }) | null>(null);

  const run = async (name: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(name);
    try {
      await fn();
      if (success) toast.success(success);
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run(
      'connect',
      async () => {
        await zapierService.connect(token.trim());
        setToken('');
        await refetch();
      },
      'Zapier connected',
    );

  const refresh = () =>
    run('refresh', async () => {
      queryClient.setQueryData(['zapier', 'status'], await zapierService.refresh());
    });

  const disconnect = () => {
    if (
      !window.confirm(
        'Disconnect Zapier? The AI can no longer use your Zapier apps. Records already received stay in HaiVE.',
      )
    )
      return;
    void run(
      'disconnect',
      async () => {
        await zapierService.disconnect();
        await refetch();
      },
      'Zapier disconnected',
    );
  };

  const createSource = () =>
    run('create', async () => {
      const result = await zapierService.createWebhookSource({
        label: label.trim(),
        modules,
        terminology: { deal: dealTerm.trim() || undefined, contact: contactTerm.trim() || undefined },
      });
      setCreated({ ...result, label: label.trim() });
      setAdding(false);
      setLabel('');
      setDealTerm('');
      setContactTerm('');
      await queryClient.invalidateQueries({ queryKey: ['data-sources'] });
    });

  const close = () => {
    setCreated(null);
    setAdding(false);
    onClose();
  };

  if (created) {
    return (
      <Modal
        open={open}
        onClose={close}
        title={`${created.label} added`}
        description="Finish the Zap in Zapier to start receiving records."
        maxWidth={640}
      >
        <WebhookDetails label={created.label} webhook={created.webhook} secretKey={created.key} />
        <div className={styles.actions}>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  const apps = status?.apps ?? [];
  return (
    <Modal
      open={open}
      onClose={close}
      title="Zapier"
      description="Use the apps in your Zapier account (Hoops, Gorilla Dash, …) from HaiVE."
      maxWidth={640}
    >
      <div className={styles.stack}>
        <section className={styles.section}>
          <h3 className={styles.heading}>
            <FiZap aria-hidden /> AI actions
          </h3>
          {status?.connected ? (
            <>
              <div className={styles.connected}>
                <FiCheckCircle aria-hidden />
                <div>
                  <strong>Connected</strong>
                  <span>
                    Token <code>{status.tokenMasked}</code>
                    {status.refreshedAt && ` · checked ${timeAgo(status.refreshedAt)}`}
                  </span>
                </div>
              </div>
              {status.error && (
                <p className={styles.warning}>
                  <FiAlertTriangle aria-hidden /> {status.error}
                </p>
              )}
              {!status.error && status.mode === 'agentic' && (
                <p className={styles.warning}>
                  <FiAlertTriangle aria-hidden /> This Zapier MCP server is in <strong>Agentic</strong> mode, so it
                  exposes no fixed actions. At mcp.zapier.com switch it to <strong>Managed</strong> mode, enable the
                  actions HaiVE may use, then press Refresh.
                </p>
              )}
              {!status.error && status.mode === 'managed' && apps.length === 0 && (
                <p className={styles.note}>
                  <FiInfo aria-hidden /> No actions are enabled yet. Add some to the server at mcp.zapier.com, then
                  press Refresh.
                </p>
              )}
              {apps.length > 0 && (
                <ul className={styles.apps}>
                  {apps.map((app) => (
                    <li key={app.app}>
                      <strong>{app.app}</strong>
                      <span>
                        {app.read.length > 0
                          ? `Can look up: ${app.read.join(', ')}`
                          : 'No look-up actions — existing records can’t be read via Zapier'}
                      </span>
                      {app.write.length > 0 && <span>Can do (after you confirm): {app.write.join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.actions}>
                <Button type="button" variant="ghost" size="sm" loading={busy === 'disconnect'} onClick={disconnect}>
                  Disconnect
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  leftIcon={<FiRefreshCw />}
                  loading={busy === 'refresh'}
                  onClick={() => void refresh()}
                >
                  Refresh
                </Button>
              </div>
            </>
          ) : (
            <form
              className={styles.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              <ol className={styles.steps}>
                <li>
                  Open <strong>mcp.zapier.com</strong> and create a new MCP server for an{' '}
                  <strong>other / custom client</strong>.
                </li>
                <li>
                  Keep it in <strong>Managed</strong> mode and add the actions HaiVE may use (e.g. Hoops: Create
                  Customer, Gorilla Dash: Create Enquiry).
                </li>
                <li>
                  On the <strong>Connect</strong> tab copy the server’s token and paste it below.
                </li>
              </ol>
              <Input
                label="Zapier MCP token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="new-password"
                leftIcon={<FiKey />}
              />
              <p className={styles.note}>
                <FiInfo aria-hidden /> HaiVE checks the token with Zapier, stores it encrypted and never shows it again.
                Each action the AI runs uses 2 Zapier tasks.
              </p>
              <div className={styles.actions}>
                <Button type="submit" loading={busy === 'connect'} disabled={token.trim().length < 8}>
                  Connect Zapier
                </Button>
              </div>
            </form>
          )}
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>
            <FiPlus aria-hidden /> New records into HaiVE
          </h3>
          <p className={styles.note}>
            <FiInfo aria-hidden /> Zapier can’t read an app’s existing records, but a Zap can send each new one to HaiVE
            as it’s created. Each app becomes its own data source, never mixed with another CRM. Needs a Zapier plan
            with “Webhooks by Zapier”.
          </p>
          {webhookSources.length > 0 && (
            <ul className={styles.apps}>
              {webhookSources.map((s) => (
                <li key={s.id} className={styles.sourceRow}>
                  <div>
                    <strong>{s.label}</strong>
                    <span>
                      {s.webhook?.lastReceivedAt
                        ? `${s.webhook.received} received · last ${timeAgo(s.webhook.lastReceivedAt)}`
                        : 'Nothing received yet'}
                    </span>
                  </div>
                  {s.status === 'active' ? (
                    <Badge variant="success">Receiving</Badge>
                  ) : (
                    <Badge variant="neutral">Disconnected</Badge>
                  )}
                  <Button type="button" size="sm" variant="ghost" onClick={() => onOpenSource(s.id)}>
                    Set up
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {adding ? (
            <form
              className={styles.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void createSource();
              }}
            >
              <Input
                label="App name"
                placeholder="Hoops"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={60}
              />
              <fieldset className={styles.kinds}>
                <legend>What will it send?</legend>
                {RECORD_KINDS.map((k) => (
                  <label key={k.module}>
                    <input
                      type="checkbox"
                      checked={modules.includes(k.module)}
                      onChange={(e) =>
                        setModules((m) => (e.target.checked ? [...m, k.module] : m.filter((x) => x !== k.module)))
                      }
                    />
                    <span>
                      {k.label} <small>{k.example}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className={styles.row}>
                <Input
                  label="It calls deals…"
                  placeholder="Job"
                  value={dealTerm}
                  onChange={(e) => setDealTerm(e.target.value)}
                  maxLength={40}
                />
                <Input
                  label="It calls contacts…"
                  placeholder="Customer"
                  value={contactTerm}
                  onChange={(e) => setContactTerm(e.target.value)}
                  maxLength={40}
                />
              </div>
              <div className={styles.actions}>
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={busy === 'create'} disabled={!label.trim() || modules.length === 0}>
                  Create webhook
                </Button>
              </div>
            </form>
          ) : (
            <div className={styles.actions}>
              <Button type="button" variant="secondary" size="sm" leftIcon={<FiPlus />} onClick={() => setAdding(true)}>
                Add an app
              </Button>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
