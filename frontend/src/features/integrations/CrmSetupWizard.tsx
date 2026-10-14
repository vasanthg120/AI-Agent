import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiAlertTriangle, FiCheckCircle, FiClock, FiInfo, FiKey, FiLoader, FiXCircle } from 'react-icons/fi';
import { Button, CopyableText, Input, Modal, Stepper } from '@/components/ui';
import { env } from '@/config/env';
import {
  crmIntegrationsService,
  integrationErrorOf,
  type CrmIntegration,
  type Discovery,
  type IntegrationError,
  type WebhookInfo,
} from '@/services/crmIntegrationsService';
import { extractErrorMessage } from '@/utils/errors';
import { MappingEditor } from './MappingEditor';
import styles from './integrations.module.css';

type Step = 'connect' | 'data' | 'mapping' | 'sync';

const MODULE_TERM: Record<string, string> = { deals: 'deal', quotes: 'quote', contacts: 'contact', accounts: 'account' };
const plural = (word: string) => (/(s|x|ch|sh)$/i.test(word) ? `${word}es` : /[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);

export function webhookAddress(webhook: WebhookInfo, module: string): string {
  const base = webhook.baseUrl || new URL(env.apiUrl, window.location.origin).toString().replace(/\/+$/, '');
  return `${base}${webhook.paths[module] ?? ''}`;
}

export function isLocalAddress(url: string): boolean {
  try {
    return /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A problem in plain words, with the technical part folded away. */
export function ErrorNotice({ error, children }: { error: IntegrationError; children?: React.ReactNode }) {
  return (
    <div className={styles.errorBox} role="alert">
      <div className={styles.errorHead}>
        <FiXCircle aria-hidden />
        <span>{error.message}</span>
      </div>
      {children && <div className={styles.rowActions}>{children}</div>}
      {error.detail && (
        <details className={styles.details}>
          <summary>View technical details</summary>
          <code className={styles.technical}>{error.detail}</code>
        </details>
      )}
    </div>
  );
}

function Line({ state, children }: { state: 'ok' | 'warn' | 'busy' | 'wait'; children: React.ReactNode }) {
  const icon = state === 'ok' ? <FiCheckCircle /> : state === 'warn' ? <FiAlertTriangle /> : state === 'busy' ? <FiLoader /> : <FiClock />;
  return (
    <li className={styles[`line_${state}`]}>
      {icon}
      <span>{children}</span>
    </li>
  );
}

interface Props {
  integration: CrmIntegration | null;
  onClose: () => void;
}

// Connecting a CRM, one understandable step at a time. Which steps appear —
// and what the first one asks for — come from the chosen CRM itself: a CRM
// HaiVE reads from asks for its sign-in details and is checked by reading a
// first page of data; a CRM that sends records to HaiVE (Hoops) gets an
// address and a key instead. Either way the customer reviews the field
// mapping before any data is synced.
export function CrmSetupWizard({ integration, onClose }: Props) {
  const queryClient = useQueryClient();
  const provider = integration?.id ?? '';
  const push = integration?.connection === 'push';
  const [step, setStep] = useState<Step>('connect');
  const [values, setValues] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IntegrationError | null>(null);
  const [current, setCurrent] = useState<CrmIntegration | null>(integration);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [webhookKey, setWebhookKey] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ status: string; error?: string; counts?: Record<string, number> } | null>(null);

  // A fresh wizard each time it's opened for an integration.
  useEffect(() => {
    if (!integration) return;
    setCurrent(integration);
    setValues(Object.fromEntries(integration.setup.fields.map((f) => [f.key, f.defaultValue ?? ''])));
    setShowAdvanced(false);
    setError(null);
    setDiscovery(null);
    setWebhookKey(null);
    setSyncResult(null);
    // Already set up but still waiting for its first record: pick up at the "send records" step.
    setStep(integration.source && integration.connection === 'push' ? 'data' : 'connect');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integration?.id]);

  const sourceId = current?.source?.id;

  // Push CRMs: watch for the first record while the customer finishes the Zap.
  const { data: live } = useQuery({
    queryKey: ['crm-integrations', 'wizard-poll', provider],
    queryFn: async () => (await crmIntegrationsService.list()).find((i) => i.id === provider) ?? null,
    enabled: !!integration && push && step === 'data' && !!sourceId,
    refetchInterval: 5_000,
  });
  useEffect(() => {
    if (live) setCurrent(live);
  }, [live]);

  const { data: suggestions } = useQuery({
    queryKey: ['crm-mapping', sourceId],
    queryFn: () => crmIntegrationsService.suggestMapping(sourceId!),
    enabled: !!sourceId && step === 'data',
    refetchInterval: push ? 6_000 : false,
  });

  if (!integration || !current) return null;
  const label = integration.label;
  const termOf = (module: string) => plural(current.source?.terminology[MODULE_TERM[module]] ?? integration.label);
  const refreshList = () => queryClient.invalidateQueries({ queryKey: ['crm-integrations'] });

  const close = () => {
    void refreshList();
    onClose();
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await crmIntegrationsService.connect(provider, values);
      setCurrent(result.integration);
      setDiscovery(result.discovery ?? null);
      setWebhookKey(result.webhookKey ?? null);
      setStep('data');
      void refreshList();
    } catch (err) {
      setError(integrationErrorOf(err) ?? { message: extractErrorMessage(err), kind: 'other' });
    } finally {
      setBusy(false);
    }
  };

  const replaceKey = async () => {
    setBusy(true);
    try {
      const result = await crmIntegrationsService.rotateKey(provider);
      setCurrent(result.integration);
      setWebhookKey(result.webhookKey ?? null);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startSync = async () => {
    setBusy(true);
    setSyncResult(null);
    try {
      const { result, integration: updated } = await crmIntegrationsService.syncNow(provider);
      setCurrent(updated);
      setSyncResult({ ...result, counts: updated.source?.records });
      void refreshList();
    } catch (err) {
      setSyncResult({ status: 'error', error: extractErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const steps: { id: Step; label: string }[] = [
    { id: 'connect', label: 'Connect' },
    { id: 'data', label: push ? 'Send records' : 'Check data' },
    { id: 'mapping', label: 'Map fields' },
    ...(push ? [] : [{ id: 'sync' as const, label: 'Start sync' }]),
  ];
  const order = steps.map((s) => s.id);
  const completed = order.slice(0, order.indexOf(step));

  const missing = integration.setup.fields.filter((f) => f.required && !(values[f.key] ?? '').trim());
  const received = (current.source?.webhook?.received ?? 0) > 0 || (suggestions?.modules.some((m) => m.sourceFields.length > 0) ?? false);
  const webhook = current.source?.webhook;

  return (
    <Modal open onClose={close} title={`Connect ${label}`} description={integration.description} maxWidth={step === 'mapping' ? 860 : 620}>
      <div className={styles.stack}>
        <Stepper steps={steps} currentId={step} completedIds={completed} />

        {step === 'connect' && (
          <form
            className={styles.stack}
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && missing.length === 0) void connect();
            }}
          >
            <div className={styles.twoLists}>
              <div>
                <strong>What HaiVE gets</strong>
                <ul className={styles.checkList}>
                  {integration.setup.provides.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              {integration.setup.limitations.length > 0 && (
                <div>
                  <strong>Good to know</strong>
                  <ul className={styles.noteList}>
                    {integration.setup.limitations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {integration.setup.fields
              .filter((f) => !f.advanced)
              .map((field) => (
                <Input
                  key={field.key}
                  label={field.label}
                  type={field.type === 'password' ? 'password' : 'text'}
                  autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                  hint={field.hint}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  leftIcon={field.type === 'password' ? <FiKey /> : undefined}
                />
              ))}
            {integration.setup.fields.some((f) => f.advanced) && (
              <details className={styles.details} open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
                <summary>Advanced</summary>
                {integration.setup.fields
                  .filter((f) => f.advanced)
                  .map((field) => (
                    <Input
                      key={field.key}
                      label={field.label}
                      hint={field.hint ?? 'Only change this if your provider told you to.'}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    />
                  ))}
              </details>
            )}

            {push ? (
              <p className={styles.note}>
                <FiInfo aria-hidden /> Nothing is typed into HaiVE. HaiVE gives you an address and a key; {label} sends each new record there.
              </p>
            ) : (
              <p className={styles.note}>
                <FiInfo aria-hidden /> HaiVE checks these details by reading a first page of your data. They’re stored encrypted and never shown
                again. Nothing is synced until you’ve reviewed the mapping.
              </p>
            )}

            {busy && !push && (
              <ul className={styles.lines}>
                <Line state="busy">Signing in to {label} and reading a first page of data…</Line>
              </ul>
            )}
            {error && (
              <ErrorNotice error={error}>
                <Button type="submit" size="sm" variant="secondary" loading={busy}>
                  Try again
                </Button>
              </ErrorNotice>
            )}
            <div className={styles.footer}>
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={missing.length > 0}>
                {push ? `Set up ${label}` : 'Connect & check'}
              </Button>
            </div>
          </form>
        )}

        {step === 'data' && !push && (
          <>
            <ul className={styles.lines}>
              <Line state="ok">Sign-in accepted</Line>
              <Line state="ok">Connected to {label}</Line>
              {Object.entries(discovery ?? {}).map(([module, found]) => (
                <Line key={module} state={found.records > 0 ? 'ok' : 'warn'}>
                  {found.records > 0
                    ? `${found.records.toLocaleString()}${found.records >= 50 ? '+' : ''} ${termOf(module).toLowerCase()} found in the first page, with ${found.fields} fields`
                    : `No ${termOf(module).toLowerCase()} found yet`}
                </Line>
              ))}
              {suggestions ? (
                <>
                  <Line state="ok">Fields analysed</Line>
                  <Line state={suggestions.reviewCount > 0 ? 'warn' : 'ok'}>
                    {suggestions.reviewCount > 0
                      ? `${suggestions.reviewCount} field${suggestions.reviewCount === 1 ? ' needs' : 's need'} your confirmation`
                      : 'Every field was matched'}
                  </Line>
                </>
              ) : (
                <Line state="busy">Analysing the fields…</Line>
              )}
            </ul>
            <div className={styles.footer}>
              <Button type="button" variant="ghost" onClick={close}>
                Finish later
              </Button>
              <Button type="button" onClick={() => setStep('mapping')} disabled={!suggestions}>
                Review mapping
              </Button>
            </div>
          </>
        )}

        {step === 'data' && push && webhook && (
          <>
            {webhookKey ? (
              <div className={styles.secretBox}>
                <strong>
                  <FiKey aria-hidden /> Your key — copy it now, it won’t be shown again
                </strong>
                <CopyableText value={webhookKey} />
              </div>
            ) : (
              <p className={styles.note}>
                <FiKey aria-hidden /> Key {webhook.keyHint ? <code>{webhook.keyHint}</code> : 'already created'} — if you no longer have it,{' '}
                <button type="button" className={styles.linkButton} disabled={busy} onClick={() => void replaceKey()}>
                  create a new one
                </button>{' '}
                (the old one stops working).
              </p>
            )}
            <div className={styles.addresses}>
              {Object.keys(webhook.paths).map((module) => (
                <div key={module}>
                  <span>Address for {termOf(module).toLowerCase()}</span>
                  <CopyableText value={webhookAddress(webhook, module)} />
                </div>
              ))}
            </div>
            {Object.keys(webhook.paths).some((m) => isLocalAddress(webhookAddress(webhook, m))) && (
              <p className={styles.problem}>
                <FiAlertTriangle aria-hidden /> This address only works on your own network, so {label} can’t reach it yet. Ask your
                administrator to set HaiVE’s public address on the server.
              </p>
            )}
            <ol className={styles.steps}>
              {(integration.setup.steps ?? []).map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ol>
            <ul className={styles.lines}>
              {received ? (
                <Line state="ok">First records received from {label}</Line>
              ) : (
                <Line state="wait">Waiting for the first record from {label}… this page updates by itself.</Line>
              )}
            </ul>
            <div className={styles.footer}>
              <Button type="button" variant="ghost" onClick={close}>
                {received ? 'Close' : 'Finish later'}
              </Button>
              <Button type="button" onClick={() => setStep('mapping')} disabled={!received}>
                Review mapping
              </Button>
            </div>
          </>
        )}

        {step === 'mapping' && sourceId && (
          <MappingEditor
            sourceId={sourceId}
            crmLabel={label}
            terminology={current.source?.terminology ?? {}}
            saveLabel={push ? 'Save & finish' : 'Save & continue'}
            onSaved={() => {
              if (push) {
                toast.success(`${label} is set up — new records will appear as they are created.`);
                close();
              } else {
                setStep('sync');
              }
            }}
          />
        )}

        {step === 'sync' && (
          <>
            <ul className={styles.lines}>
              <Line state="ok">Connected to {label}</Line>
              <Line state="ok">Field mapping saved</Line>
              {busy && <Line state="busy">Syncing your {label} records… this can take a few minutes.</Line>}
              {syncResult?.status === 'ok' && (
                <Line state="ok">
                  First sync finished —{' '}
                  {Object.entries(syncResult.counts ?? {})
                    .map(([m, n]) => `${n.toLocaleString()} ${termOf(m).toLowerCase()}`)
                    .join(', ') || 'no records'}
                </Line>
              )}
            </ul>
            {syncResult?.status === 'error' && (
              <ErrorNotice
                error={current.source?.error ?? { message: syncResult.error ?? 'The first sync didn’t finish.', kind: 'other' }}
              >
                <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => void startSync()}>
                  Try again
                </Button>
              </ErrorNotice>
            )}
            {!syncResult && !busy && (
              <p className={styles.note}>
                <FiInfo aria-hidden /> The first sync brings in your existing {label} records. After that HaiVE keeps them up to date
                automatically.
              </p>
            )}
            <div className={styles.footer}>
              {syncResult?.status === 'ok' ? (
                <Button type="button" onClick={close}>
                  Done
                </Button>
              ) : (
                <>
                  <Button type="button" variant="ghost" onClick={close} disabled={busy}>
                    Sync later
                  </Button>
                  <Button type="button" loading={busy} onClick={() => void startSync()}>
                    Start sync
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
