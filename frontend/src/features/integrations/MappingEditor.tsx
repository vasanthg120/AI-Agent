import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiAlertTriangle, FiCheck, FiCpu, FiEye, FiRotateCcw, FiSearch } from 'react-icons/fi';
import { Badge, Button, EmptyState, Input, Skeleton, Tabs, type BadgeVariant } from '@/components/ui';
import {
  crmIntegrationsService,
  type FieldMappings,
  type FieldSuggestion,
  type MappingPreview,
} from '@/services/crmIntegrationsService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import styles from './integrations.module.css';

const MODULE_TERM: Record<string, string> = { deals: 'deal', quotes: 'quote', contacts: 'contact', accounts: 'account' };
const plural = (word: string) => (/(s|x|ch|sh)$/i.test(word) ? `${word}es` : /[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);

interface Props {
  sourceId: string;
  crmLabel: string;
  terminology: Record<string, string>;
  // Called after a mapping was saved (the wizard moves on; the manage view just refreshes).
  onSaved?: () => void;
  saveLabel?: string;
}

function statusOf(field: FieldSuggestion, chosen: string, confirmed: boolean): { label: string; variant: BadgeVariant } {
  if (!chosen) return field.required ? { label: 'Required', variant: 'danger' } : { label: 'Not mapped', variant: 'neutral' };
  if (chosen !== (field.source ?? '')) return { label: 'Your choice', variant: 'success' };
  if (field.method === 'saved' && !field.needsReview) return { label: 'Saved', variant: 'success' };
  if (field.needsReview && !confirmed) return { label: 'Review', variant: 'warning' };
  return { label: field.method === 'ai' ? `AI · ${field.confidence}%` : `Matched · ${field.confidence}%`, variant: 'success' };
}

// Field mapping, the understandable way: one row per HaiVE field, the CRM
// field that feeds it, how sure HaiVE is and why — with search, an example
// value from the CRM's own records, a preview of the result, and the
// previous versions to go back to. Nothing changes until "Save" is pressed.
export function MappingEditor({ sourceId, crmLabel, terminology, onSaved, saveLabel = 'Save mapping' }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['crm-mapping', sourceId],
    queryFn: () => crmIntegrationsService.suggestMapping(sourceId),
  });
  const { data: versions } = useQuery({
    queryKey: ['crm-mapping-versions', sourceId],
    queryFn: () => crmIntegrationsService.mappingVersions(sourceId),
  });

  const [suggestions, setSuggestions] = useState(data);
  const [draft, setDraft] = useState<FieldMappings>({});
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [module, setModule] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<MappingPreview | null>(null);

  // Start from what HaiVE suggests: every field with a match is pre-selected,
  // unsure ones flagged for review.
  useEffect(() => {
    if (!data) return;
    setSuggestions(data);
    setDraft(
      Object.fromEntries(
        data.modules.map((m) => [m.module, Object.fromEntries(m.fields.filter((f) => f.source).map((f) => [f.key, f.source!]))]),
      ),
    );
    setConfirmed(new Set());
    setPreview(null);
    setModule((current) => (data.modules.some((m) => m.module === current) ? current : (data.modules[0]?.module ?? '')));
  }, [data]);

  const active = suggestions?.modules.find((m) => m.module === module);
  const sourceOptions = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (active?.sourceFields ?? []).filter(
      (f) => !term || f.path.toLowerCase().includes(term) || (f.example ?? '').toLowerCase().includes(term),
    );
  }, [active, search]);

  if (isLoading) return <Skeleton height={220} />;
  if (isError || !suggestions) {
    return (
      <EmptyState
        compact
        icon={FiAlertTriangle}
        title="The mapping couldn’t be loaded"
        description={extractErrorMessage(error)}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (suggestions.modules.every((m) => m.sourceFields.length === 0)) {
    return (
      <EmptyState
        compact
        icon={FiSearch}
        title="No records to learn from yet"
        description={`HaiVE works out the mapping from ${crmLabel}’s own records. Once the first records arrive, its fields appear here.`}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
            Check again
          </Button>
        }
      />
    );
  }

  const setField = (key: string, path: string) => {
    setPreview(null);
    setDraft((d) => {
      const next = { ...(d[module] ?? {}) };
      if (path) next[key] = path;
      else delete next[key];
      return { ...d, [module]: next };
    });
  };

  const labelOf = (m: string) => plural(terminology[MODULE_TERM[m]] ?? m);
  const reviewLeft = suggestions.modules.reduce(
    (n, m) =>
      n +
      m.fields.filter(
        (f) => f.needsReview && (draft[m.module]?.[f.key] ?? '') === (f.source ?? '') && !confirmed.has(`${m.module}.${f.key}`),
      ).length,
    0,
  );
  const missingRequired = suggestions.modules.filter(
    (m) => Object.keys(draft[m.module] ?? {}).length > 0 && !draft[m.module]?.externalId,
  );

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusy(null);
    }
  };

  const askAi = () =>
    run('ai', async () => {
      const result = await crmIntegrationsService.suggestMapping(sourceId, true);
      setSuggestions(result);
      // Only fields the customer hasn't settled themselves take the AI's suggestion.
      setDraft((d) => {
        const next: FieldMappings = { ...d };
        for (const m of result.modules) {
          const moduleDraft = { ...(next[m.module] ?? {}) };
          for (const f of m.fields) if (f.method === 'ai' && f.source && !moduleDraft[f.key]) moduleDraft[f.key] = f.source;
          next[m.module] = moduleDraft;
        }
        return next;
      });
      toast.success(result.aiUsed ? 'AI suggestions added — please review them.' : 'Nothing was left for the AI to work out.');
    });

  const showPreview = () => run('preview', async () => setPreview(await crmIntegrationsService.previewMapping(sourceId, draft)));

  const save = () =>
    run('save', async () => {
      await crmIntegrationsService.saveMapping(sourceId, draft);
      toast.success('Mapping saved');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['crm-mapping', sourceId] }),
        queryClient.invalidateQueries({ queryKey: ['crm-mapping-versions', sourceId] }),
        queryClient.invalidateQueries({ queryKey: ['crm-integrations'] }),
      ]);
      onSaved?.();
    });

  const restore = (version: number) => {
    if (!window.confirm('Go back to this earlier mapping? The current one is kept as a version too.')) return;
    void run(`restore-${version}`, async () => {
      await crmIntegrationsService.restoreMapping(sourceId, version);
      toast.success('Earlier mapping restored');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['crm-mapping', sourceId] }),
        queryClient.invalidateQueries({ queryKey: ['crm-mapping-versions', sourceId] }),
      ]);
    });
  };

  return (
    <div className={styles.stack}>
      <div className={styles.mappingToolbar}>
        <Tabs
          items={suggestions.modules.map((m) => ({ id: m.module, label: labelOf(m.module) }))}
          activeId={module}
          onChange={(id) => {
            setModule(id);
            setSearch('');
          }}
        />
        <div className={styles.rowActions}>
          <Button type="button" variant="ghost" size="sm" leftIcon={<FiCpu />} loading={busy === 'ai'} onClick={() => void askAi()}>
            Suggest with AI
          </Button>
          <Button type="button" variant="ghost" size="sm" leftIcon={<FiEye />} loading={busy === 'preview'} onClick={() => void showPreview()}>
            Preview
          </Button>
        </div>
      </div>

      {active && (
        <>
          <div className={styles.mappingSearch}>
            <Input
              type="search"
              aria-label={`Search ${crmLabel} fields`}
              placeholder={`Search ${crmLabel} fields (${active.sourceFields.length})`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              leftIcon={<FiSearch />}
            />
          </div>
          <div className={styles.mappingHead} aria-hidden>
            <span>HaiVE field</span>
            <span>{crmLabel} field</span>
            <span>Status</span>
          </div>
          {active.fields.map((field) => {
            const chosen = draft[module]?.[field.key] ?? '';
            const id = `${module}.${field.key}`;
            const status = statusOf(field, chosen, confirmed.has(id));
            const example = active.sourceFields.find((f) => f.path === chosen)?.example;
            const needsConfirm = field.needsReview && chosen === (field.source ?? '') && chosen !== '' && !confirmed.has(id);
            return (
              <div key={field.key} className={styles.mappingRow}>
                <div>
                  <strong>
                    {field.label}
                    {field.required && <span className={styles.requiredMark}> *</span>}
                  </strong>
                  <span className={styles.muted}>{field.hint}</span>
                </div>
                <div>
                  <select
                    className={styles.select}
                    aria-label={`${crmLabel} field for ${field.label}`}
                    value={chosen}
                    onChange={(e) => setField(field.key, e.target.value)}
                  >
                    <option value="">{field.required ? 'Choose a field…' : 'Don’t import (ignore)'}</option>
                    {/* The chosen field stays selectable even when the search hides it. */}
                    {chosen && !sourceOptions.some((f) => f.path === chosen) && <option value={chosen}>{chosen}</option>}
                    {sourceOptions.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                        {f.example ? ` — e.g. ${f.example}` : ''}
                      </option>
                    ))}
                  </select>
                  {chosen && <span className={styles.muted}>{example ? `Example: ${example}` : 'No example value seen yet'}</span>}
                </div>
                <div className={styles.mappingStatus}>
                  <Badge variant={status.variant}>{status.label}</Badge>
                  {/* A saved, unquestioned mapping needs no explanation beyond its badge. */}
                  {chosen === (field.source ?? '') && field.reason && !(field.method === 'saved' && !field.needsReview) && (
                    <span className={styles.muted}>{field.reason}</span>
                  )}
                  {needsConfirm && (
                    <button type="button" className={styles.linkButton} onClick={() => setConfirmed((c) => new Set(c).add(id))}>
                      <FiCheck aria-hidden /> Looks right
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}

      {preview && (
        <div className={styles.previewBox}>
          <strong>Preview — how {crmLabel}’s records will look in HaiVE</strong>
          {preview.problems.map((p) => (
            <p key={p} className={styles.problem}>
              <FiAlertTriangle aria-hidden /> {p}
            </p>
          ))}
          {preview.rows.length === 0 ? (
            <span className={styles.muted}>No sample records to preview yet.</span>
          ) : (
            preview.rows.map((row, i) => (
              <div key={i} className={styles.previewRow}>
                <Badge variant="neutral">{labelOf(row.module)}</Badge>
                <dl>
                  {Object.entries(row.values).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value === null || value === '' ? <span className={styles.muted}>empty</span> : String(value)}</dd>
                    </div>
                  ))}
                </dl>
                {row.problems.map((p) => (
                  <p key={p} className={styles.problem}>
                    <FiAlertTriangle aria-hidden /> {p}
                  </p>
                ))}
              </div>
            ))
          )}
        </div>
      )}

      {missingRequired.length > 0 && (
        <p className={styles.problem}>
          <FiAlertTriangle aria-hidden /> Choose the Record ID field for {missingRequired.map((m) => labelOf(m.module)).join(' and ')} —
          without it HaiVE can’t tell one record from another.
        </p>
      )}

      <div className={styles.mappingFooter}>
        <span className={styles.muted}>
          {reviewLeft > 0
            ? `${reviewLeft} field${reviewLeft === 1 ? '' : 's'} still marked for review — check the suggestion or pick another field.`
            : 'Every suggested field has been checked.'}
        </span>
        <Button type="button" loading={busy === 'save'} disabled={missingRequired.length > 0} onClick={() => void save()}>
          {saveLabel}
        </Button>
      </div>

      {versions && versions.length > 0 && (
        <details className={styles.details}>
          <summary>Earlier versions of this mapping ({versions.length})</summary>
          <ul className={styles.versionList}>
            {versions.map((v) => (
              <li key={v.version}>
                <span>
                  Version {v.version} · {v.fieldCount} fields · replaced {formatRelativeTime(v.replacedAt)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  leftIcon={<FiRotateCcw />}
                  loading={busy === `restore-${v.version}`}
                  onClick={() => restore(v.version)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
