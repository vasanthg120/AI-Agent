import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  FiAlertCircle,
  FiCheck,
  FiCheckCircle,
  FiDatabase,
  FiLink2,
  FiMail,
  FiPlus,
  FiRefreshCw,
  FiRotateCcw,
  FiSliders,
  FiStar,
  FiTrash2,
  FiX,
  FiZap,
} from 'react-icons/fi';
import { Badge, Button, Input, Skeleton, StringListEditor, Switch, Tabs } from '@/components/ui';
import { timeAgo } from '@/components/data-sources/timeAgo';
import { ROUTES } from '@/constants/routes';
import { useDataSources } from '@/hooks/useDataSources';
import {
  dataSourcesService,
  MODULE_LABEL,
  pluralize,
  type CrmModule,
  type DataSourceAdminView,
  type FieldMappings,
  type MirroredModule,
  type StageMapping,
  type Terminology,
} from '@/services/dataSourcesService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../components/SettingsSection';
import { ConnectGorillaDashModal } from './data-sources/ConnectGorillaDashModal';
import { WebhookSourceModal } from './data-sources/WebhookSourceModal';
import { ZapierModal } from './data-sources/ZapierModal';
import styles from './DataSourcesSettings.module.css';

const MIRRORED: MirroredModule[] = ['deals', 'quotes', 'contacts', 'accounts'];
const TERM_KEY: Record<MirroredModule, keyof Terminology> = {
  deals: 'deal',
  quotes: 'quote',
  contacts: 'contact',
  accounts: 'account',
};
const EDITOR_TABS = [
  { id: 'mappings', label: 'Field mapping' },
  { id: 'status', label: 'Won / lost & stages' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'general', label: 'Naming & sync' },
];

interface Draft {
  label: string;
  terminology: Terminology;
  modules: CrmModule[];
  fieldMappings: FieldMappings;
  won: string[];
  lost: string[];
  stageMappings: StageMapping[];
  syncEnabled: boolean;
  syncIntervalMinutes: number;
}

function draftOf(source: DataSourceAdminView): Draft {
  return {
    label: source.label,
    terminology: source.terminology,
    modules: source.modules,
    fieldMappings: source.fieldMappings,
    won: source.statusMapping.won,
    lost: source.statusMapping.lost,
    stageMappings: source.stageMappings,
    syncEnabled: source.sync.enabled,
    syncIntervalMinutes: source.sync.intervalMinutes,
  };
}

function SyncLine({ source }: { source: DataSourceAdminView }) {
  if (source.native) return <span className={styles.meta}>Records created directly in HaiVE — nothing to sync.</span>;
  if (source.webhook) {
    if (source.sync.lastStatus === 'error')
      return (
        <span className={styles.syncError}>
          <FiAlertCircle aria-hidden /> Last delivery {timeAgo(source.sync.lastSyncAt)} was refused:{' '}
          {source.sync.lastError}
        </span>
      );
    return (
      <span className={styles.meta}>
        {source.webhook.lastReceivedAt
          ? `Receives new records from Zapier · last ${timeAgo(source.webhook.lastReceivedAt)}`
          : 'Receives new records from Zapier · nothing received yet'}
      </span>
    );
  }
  if (!source.sync.supported) return <span className={styles.meta}>HaiVE can’t sync this CRM automatically yet.</span>;
  const { lastStatus, lastSyncAt, lastError } = source.sync;
  if (lastStatus === 'running') return <span className={styles.meta}>Syncing now…</span>;
  if (lastStatus === 'error')
    return (
      <span className={styles.syncError}>
        <FiAlertCircle aria-hidden /> Last sync failed {timeAgo(lastSyncAt)}: {lastError}
      </span>
    );
  if (lastStatus === 'never') return <span className={styles.meta}>Not synced yet.</span>;
  return (
    <span className={styles.meta}>
      Synced {timeAgo(lastSyncAt)}
      {source.sync.enabled ? ` · every ${source.sync.intervalMinutes} min` : ' · automatic sync off'}
    </span>
  );
}

// Settings -> Data Sources. Every connected CRM is its own data source: its
// data is kept apart from every other CRM's, its fields are mapped onto
// HaiVE's model here (a CRM that calls deals "Opportunities" or keeps the
// amount in a custom field is a setting, not a code change), and it's clear
// which metrics it can and can't provide.
export function DataSourcesSettings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: overview } = useDataSources();
  const {
    data: sources,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['data-sources', 'admin'],
    queryFn: dataSourcesService.listForAdmin,
    refetchInterval: (q) => (q.state.data?.some((s) => s.sync.lastStatus === 'running') ? 3_000 : false),
  });
  const { data: catalog } = useQuery({
    queryKey: ['data-sources', 'catalog'],
    queryFn: dataSourcesService.getCatalog,
    staleTime: Infinity,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState('mappings');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [gorillaOpen, setGorillaOpen] = useState(false);
  const [zapierOpen, setZapierOpen] = useState(false);
  const [webhookSourceId, setWebhookSourceId] = useState<string | null>(null);

  const selected = useMemo(
    () => sources?.find((s) => s.id === selectedId) ?? sources?.find((s) => s.isDefault) ?? sources?.[0],
    [sources, selectedId],
  );

  useEffect(() => {
    if (selected) setDraft(draftOf(selected));
    // Re-seed only when switching source (or after a save refreshed it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.fieldMappings, selected?.label]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['data-sources'] }),
      // Default source or mappings changed -> every CRM figure may change.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'data-sources' }),
    ]);

  const run = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(message);
      await refresh();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusy(null);
    }
  };

  const syncNow = (source: DataSourceAdminView) =>
    run(
      `sync-${source.id}`,
      async () => {
        const result = await dataSourcesService.syncNow(source.id);
        if (result.status === 'error') throw new Error(result.error ?? 'Sync failed');
      },
      `${source.label} synced`,
    );

  const dirty = !!selected && !!draft && JSON.stringify(draft) !== JSON.stringify(draftOf(selected));

  const save = async () => {
    if (!selected || !draft) return;
    setSaving(true);
    try {
      await dataSourcesService.update(selected.id, {
        label: draft.label,
        terminology: draft.terminology,
        modules: draft.modules,
        ...(selected.native ? {} : { fieldMappings: draft.fieldMappings }),
        statusMapping: { won: draft.won.filter(Boolean), lost: draft.lost.filter(Boolean) },
        stageMappings: draft.stageMappings.filter((s) => s.value.trim()),
        syncEnabled: draft.syncEnabled,
        syncIntervalMinutes: draft.syncIntervalMinutes,
      });
      toast.success('Saved. The next sync uses the new settings.');
      await refresh();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <SettingsSection icon={<FiDatabase />} title="Data sources" description="Where HaiVE’s CRM figures come from.">
        <Skeleton height={120} />
        <Skeleton height={120} />
      </SettingsSection>
    );
  }
  if (isError || !sources) {
    return (
      <SettingsSection icon={<FiDatabase />} title="Data sources" description="Where HaiVE’s CRM figures come from.">
        <div className={styles.errorState} role="alert">
          <span>Couldn’t load data sources. {extractErrorMessage(error)}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      </SettingsSection>
    );
  }

  const setMapping = (module: MirroredModule, field: string, value: string) =>
    setDraft(
      (d) =>
        d && {
          ...d,
          fieldMappings: { ...d.fieldMappings, [module]: { ...(d.fieldMappings[module] ?? {}), [field]: value } },
        },
    );

  return (
    <div className={styles.page}>
      <SettingsSection
        icon={<FiDatabase />}
        title="Data sources"
        description="Each CRM you connect is kept separate — its data is never mixed with another CRM’s unless someone picks the Unified view. The default source is what dashboards show until people choose another in the top bar."
        actions={
          <div className={styles.headerActions}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<FiRefreshCw />}
              loading={busy === 'reconcile'}
              onClick={() => void run('reconcile', dataSourcesService.reconcile, 'Connections re-checked')}
            >
              Re-check
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<FiLink2 />}
              onClick={() => navigate(ROUTES.settingsIntegrations)}
            >
              Connect a CRM
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<FiLink2 />}
              onClick={() => setGorillaOpen(true)}
            >
              Gorilla Dash
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<FiZap />}
              onClick={() => setZapierOpen(true)}
            >
              Zapier
            </Button>
          </div>
        }
      >
        <div className={styles.cards}>
          {sources.map((source) => {
            const active = selected?.id === source.id;
            return (
              <article key={source.id} className={clsx(styles.card, active && styles.cardActive)}>
                <header className={styles.cardHead}>
                  <span className={styles.cardIcon} aria-hidden>
                    <FiDatabase />
                  </span>
                  <div className={styles.cardTitle}>
                    <strong>{source.label}</strong>
                    {(source.native || source.providerLabel !== source.label) && (
                      <span className={styles.meta}>
                        {source.native ? 'Records created in HaiVE' : source.providerLabel}
                      </span>
                    )}
                  </div>
                  {source.isDefault ? (
                    <Badge variant="accent">
                      <FiStar aria-hidden /> Default
                    </Badge>
                  ) : source.native ? (
                    <Badge variant="neutral">Built in</Badge>
                  ) : source.status === 'active' ? (
                    <Badge variant="success" dot>
                      Connected
                    </Badge>
                  ) : (
                    <Badge variant="neutral">Disconnected</Badge>
                  )}
                </header>

                <dl className={styles.counts}>
                  {MIRRORED.filter((m) => source.modules.includes(m)).map((m) => (
                    <div key={m}>
                      <dt>{pluralize(source.terminology[TERM_KEY[m]])}</dt>
                      <dd>{source.recordCounts[m].toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>

                <SyncLine source={source} />

                <div className={styles.cardActions}>
                  <Button
                    type="button"
                    size="sm"
                    variant={active ? 'secondary' : 'outline'}
                    leftIcon={<FiSliders />}
                    onClick={() => setSelectedId(source.id)}
                  >
                    {active ? 'Configuring' : 'Configure'}
                  </Button>
                  {!source.native && source.sync.supported && source.status === 'active' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      leftIcon={<FiRefreshCw />}
                      loading={busy === `sync-${source.id}`}
                      onClick={() => void syncNow(source)}
                    >
                      Sync now
                    </Button>
                  )}
                  {source.webhook && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      leftIcon={<FiZap />}
                      onClick={() => setWebhookSourceId(source.id)}
                    >
                      Webhook
                    </Button>
                  )}
                  {!source.isDefault && source.status === 'active' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      leftIcon={<FiStar />}
                      loading={busy === `default-${source.id}`}
                      onClick={() =>
                        void run(
                          `default-${source.id}`,
                          () => dataSourcesService.update(source.id, { isDefault: true }),
                          `${source.label} is now the default`,
                        )
                      }
                    >
                      Make default
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {overview && overview.emailSources.length > 0 && (
          <div className={styles.emailNote}>
            <FiMail aria-hidden />
            <span>
              Email figures (sent, responded, missed, follow-ups) come from{' '}
              {overview.emailSources
                .map((e) => `${e.label} — ${e.mailboxes} mailbox${e.mailboxes === 1 ? '' : 'es'}`)
                .join(' and ')}
              . They are kept separate from CRM data and never change with the CRM source.
            </span>
          </div>
        )}
      </SettingsSection>

      {selected && draft && catalog && (
        <SettingsSection
          icon={<FiSliders />}
          title={`Configure ${selected.label}`}
          description={
            selected.native
              ? 'Records created in HaiVE are already in HaiVE’s own format.'
              : 'How this CRM’s records map onto HaiVE. Changes apply from the next sync; nothing here touches the CRM itself.'
          }
          footer={
            <div className={styles.saveBar}>
              <span className={styles.meta}>{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
              <div className={styles.saveActions}>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!dirty || saving}
                  onClick={() => setDraft(draftOf(selected))}
                >
                  Discard
                </Button>
                <Button type="button" loading={saving} disabled={!dirty} onClick={() => void save()}>
                  Save changes
                </Button>
              </div>
            </div>
          }
        >
          <Tabs items={EDITOR_TABS} activeId={tab} onChange={setTab} />

          {tab === 'mappings' &&
            (selected.native ? (
              <p className={styles.meta}>
                Nothing to map — these records are created in HaiVE with HaiVE’s own fields.
              </p>
            ) : (
              <div className={styles.stack}>
                <div className={styles.inlineActions}>
                  <p className={styles.meta}>
                    Type the CRM’s field for each HaiVE field — dotted paths reach nested values (e.g.{' '}
                    <code>properties.amount</code>). Leave a field empty if this CRM doesn’t have it; metrics that need
                    it will say so instead of guessing.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    leftIcon={<FiRotateCcw />}
                    onClick={() =>
                      setDraft(
                        (d) =>
                          d && {
                            ...d,
                            fieldMappings: selected.defaults.fieldMappings,
                            won: selected.defaults.statusMapping.won,
                            lost: selected.defaults.statusMapping.lost,
                          },
                      )
                    }
                  >
                    Reset to {selected.providerLabel} defaults
                  </Button>
                </div>
                {MIRRORED.filter((m) => draft.modules.includes(m)).map((module) => {
                  const options = selected.availableFields[module] ?? [];
                  const listId = `fields-${selected.id}-${module}`;
                  return (
                    <div key={module} className={styles.mapGroup}>
                      <h3 className={styles.mapTitle}>
                        {MODULE_LABEL[module]}
                        {options.length > 0 && (
                          <span className={styles.meta}> · {options.length} fields seen in the last sync</span>
                        )}
                      </h3>
                      <datalist id={listId}>
                        {options.map((o) => (
                          <option key={o} value={o} />
                        ))}
                      </datalist>
                      <div
                        className={styles.mapTable}
                        role="table"
                        aria-label={`${MODULE_LABEL[module]} field mapping`}
                      >
                        {catalog.canonicalFields[module].map((field) => {
                          const value = draft.fieldMappings[module]?.[field.key] ?? '';
                          return (
                            <div key={field.key} className={styles.mapRow} role="row">
                              <div className={styles.mapHaive} role="cell">
                                <span>{field.label}</span>
                                <span className={styles.meta}>{field.hint}</span>
                              </div>
                              <span className={styles.arrow} aria-hidden>
                                ←
                              </span>
                              <div role="cell" className={styles.mapInput}>
                                <input
                                  className={clsx(styles.input, !value && styles.inputEmpty)}
                                  list={listId}
                                  value={value}
                                  placeholder="Not mapped"
                                  aria-label={`${selected.label} field for ${field.label}`}
                                  onChange={(e) => setMapping(module, field.key, e.target.value)}
                                />
                                {value && (
                                  <button
                                    type="button"
                                    className={styles.clear}
                                    aria-label={`Unmap ${field.label}`}
                                    onClick={() => setMapping(module, field.key, '')}
                                  >
                                    <FiX />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

          {tab === 'status' && (
            <div className={styles.stack}>
              <p className={styles.meta}>
                Which of this CRM’s status or stage values mean a {draft.terminology.deal.toLowerCase()} was won or
                lost. Everything else counts as open. Matching ignores upper/lower case, and “Closed Won” also matches
                “won”.
              </p>
              <div className={styles.twoCol}>
                <StringListEditor
                  label="Won values"
                  items={draft.won}
                  onChange={(won) => setDraft((d) => d && { ...d, won })}
                  addLabel="Add a won value"
                />
                <StringListEditor
                  label="Lost values"
                  items={draft.lost}
                  onChange={(lost) => setDraft((d) => d && { ...d, lost })}
                  addLabel="Add a lost value"
                />
              </div>

              <h3 className={styles.mapTitle}>Pipeline stages</h3>
              <p className={styles.meta}>
                Optional: friendly names for this CRM’s stage ids, and whether each one is open, won or lost.
              </p>
              <div className={styles.stageList}>
                {draft.stageMappings.map((stage, index) => (
                  <div key={index} className={styles.stageRow}>
                    <Input
                      aria-label="Stage id in the CRM"
                      placeholder="Stage id, e.g. closedwon"
                      value={stage.value}
                      onChange={(e) =>
                        setDraft(
                          (d) =>
                            d && {
                              ...d,
                              stageMappings: d.stageMappings.map((s, i) =>
                                i === index ? { ...s, value: e.target.value } : s,
                              ),
                            },
                        )
                      }
                    />
                    <Input
                      aria-label="Name to show"
                      placeholder="Name to show"
                      value={stage.label}
                      onChange={(e) =>
                        setDraft(
                          (d) =>
                            d && {
                              ...d,
                              stageMappings: d.stageMappings.map((s, i) =>
                                i === index ? { ...s, label: e.target.value } : s,
                              ),
                            },
                        )
                      }
                    />
                    <select
                      className={styles.select}
                      aria-label="Stage category"
                      value={stage.category}
                      onChange={(e) =>
                        setDraft(
                          (d) =>
                            d && {
                              ...d,
                              stageMappings: d.stageMappings.map((s, i) =>
                                i === index ? { ...s, category: e.target.value as StageMapping['category'] } : s,
                              ),
                            },
                        )
                      }
                    >
                      <option value="open">Open</option>
                      <option value="won">Won</option>
                      <option value="lost">Lost</option>
                    </select>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label="Remove stage"
                      onClick={() =>
                        setDraft((d) => d && { ...d, stageMappings: d.stageMappings.filter((_, i) => i !== index) })
                      }
                    >
                      <FiTrash2 />
                    </button>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  leftIcon={<FiPlus />}
                  onClick={() =>
                    setDraft(
                      (d) =>
                        d && { ...d, stageMappings: [...d.stageMappings, { value: '', label: '', category: 'open' }] },
                    )
                  }
                >
                  Add a stage
                </Button>
              </div>
            </div>
          )}

          {tab === 'capabilities' && (
            <div className={styles.stack}>
              <p className={styles.meta}>
                The parts of this CRM HaiVE uses. Turn one off if the CRM doesn’t have it — the metrics that need it
                will show “not supported” instead of zero.
              </p>
              <div className={styles.moduleGrid}>
                {catalog.modules.map((module) => (
                  <label key={module} className={styles.moduleToggle}>
                    <Switch
                      checked={draft.modules.includes(module)}
                      onChange={(on) =>
                        setDraft(
                          (d) =>
                            d && { ...d, modules: on ? [...d.modules, module] : d.modules.filter((m) => m !== module) },
                        )
                      }
                      ariaLabel={MODULE_LABEL[module]}
                    />
                    {MODULE_LABEL[module]}
                  </label>
                ))}
              </div>
              <h3 className={styles.mapTitle}>What dashboards can show from {selected.label}</h3>
              <ul className={styles.metricList}>
                {catalog.metrics
                  .filter((m) => m.kind === 'crm')
                  .map((m) => {
                    const ok = selected.supportedMetrics.includes(m.id);
                    return (
                      <li key={m.id} className={ok ? styles.metricOk : styles.metricNo}>
                        {ok ? <FiCheckCircle aria-hidden /> : <FiX aria-hidden />} {m.label}
                      </li>
                    );
                  })}
              </ul>
              {dirty && <p className={styles.meta}>Save to update this list.</p>}
            </div>
          )}

          {tab === 'general' && (
            <div className={styles.stack}>
              <div className={styles.twoCol}>
                <Input
                  label="Name"
                  value={draft.label}
                  onChange={(e) => setDraft((d) => d && { ...d, label: e.target.value })}
                  hint="Shown in the data-source picker."
                />
              </div>
              <h3 className={styles.mapTitle}>What this CRM calls things</h3>
              <p className={styles.meta}>
                Used wherever HaiVE names this CRM’s records — e.g. “Opportunity” for Salesforce, “Sales Case” for a
                custom CRM.
              </p>
              <div className={styles.fourCol}>
                {(['deal', 'quote', 'contact', 'account'] as const).map((k) => (
                  <Input
                    key={k}
                    label={
                      k === 'deal'
                        ? 'A deal is called'
                        : k === 'quote'
                          ? 'A quote is called'
                          : k === 'contact'
                            ? 'A contact is called'
                            : 'An account is called'
                    }
                    value={draft.terminology[k]}
                    onChange={(e) =>
                      setDraft((d) => d && { ...d, terminology: { ...d.terminology, [k]: e.target.value } })
                    }
                  />
                ))}
              </div>
              {!selected.native && selected.sync.supported && (
                <>
                  <h3 className={styles.mapTitle}>Sync</h3>
                  <label className={styles.moduleToggle}>
                    <Switch
                      checked={draft.syncEnabled}
                      onChange={(on) => setDraft((d) => d && { ...d, syncEnabled: on })}
                      ariaLabel="Sync automatically"
                    />
                    Sync automatically
                  </label>
                  <label className={styles.selectField}>
                    <span>Every</span>
                    <select
                      className={styles.select}
                      value={draft.syncIntervalMinutes}
                      disabled={!draft.syncEnabled}
                      onChange={(e) => setDraft((d) => d && { ...d, syncIntervalMinutes: Number(e.target.value) })}
                    >
                      {[5, 10, 15, 30, 60, 180, 720, 1440].map((m) => (
                        <option key={m} value={m}>
                          {m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : m === 1440 ? '1 day' : `${m / 60} hours`}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {selected.connectionId && (
                <p className={styles.meta}>
                  <FiCheck aria-hidden /> Reads through the “{selected.integrationProvider}” connection in Integrations.
                </p>
              )}
            </div>
          )}
        </SettingsSection>
      )}

      <ConnectGorillaDashModal open={gorillaOpen} onClose={() => setGorillaOpen(false)} />
      <ZapierModal
        open={zapierOpen}
        onClose={() => setZapierOpen(false)}
        webhookSources={sources.filter((s) => s.webhook)}
        onOpenSource={(id) => {
          setZapierOpen(false);
          setWebhookSourceId(id);
        }}
      />
      <WebhookSourceModal
        source={sources.find((s) => s.id === webhookSourceId) ?? null}
        onClose={() => setWebhookSourceId(null)}
      />
    </div>
  );
}
