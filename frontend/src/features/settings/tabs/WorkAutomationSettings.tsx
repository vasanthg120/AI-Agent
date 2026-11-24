import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiClock, FiRefreshCw, FiSend, FiUsers } from 'react-icons/fi';
import { Badge, Button, EmptyState, Input, Skeleton, Switch } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { TIMEZONE_GROUPS, isKnownTimezone } from '@/utils/timezones';
import { workAutomationService } from '@/services/workAutomationService';
import type { AutomationConfig, HierarchyPerson, IdentityRow } from '@/services/workAutomationService';
import { managerCandidates, platformLabel } from '@/features/work/workUtils';
import work from '@/features/work/Work.module.css';
import { SettingsField, SettingsSection } from '../components/SettingsSection';

const CHANNELS: { id: AutomationConfig['deliveryChannels'][number]; label: string }[] = [
  { id: 'gmail', label: "Employee's Gmail" },
  { id: 'outlook', label: "Employee's Outlook" },
  { id: 'smtp', label: 'Haive SMTP (fallback)' },
];

const NUMBER_FIELDS: { key: keyof AutomationConfig; label: string; hint: string }[] = [
  { key: 'dealCloseWindowDays', label: 'Deal closing window (days)', hint: 'Open deals expected to close within this many days become tasks.' },
  { key: 'staleDealDays', label: 'Quiet deal after (days)', hint: 'A deal with no activity for this long becomes a follow-up task.' },
  { key: 'quoteDueWindowDays', label: 'Quote payment window (days)', hint: 'Unpaid quotes due within this many days become tasks.' },
  { key: 'emailLookbackDays', label: 'Email look-back (days)', hint: 'How far back unanswered customer emails are considered.' },
  { key: 'syncOnLoginMinIntervalMin', label: 'Refresh on open, at most every (min)', hint: 'Limits how often opening Haive re-reads the platforms.' },
  { key: 'maxDeliveryAttempts', label: 'Email attempts', hint: 'Delivery tries per recipient before it is marked failed.' },
];

function ConfigSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['work-config'], queryFn: () => workAutomationService.getConfig() });
  const [draft, setDraft] = useState<AutomationConfig | null>(null);
  useEffect(() => {
    if (data) setDraft(data.config);
  }, [data]);

  const save = useMutation({
    mutationFn: (patch: Partial<AutomationConfig>) => workAutomationService.updateConfig(patch),
    onSuccess: () => {
      toast.success('Saved.');
      void queryClient.invalidateQueries({ queryKey: ['work-config'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  if (isLoading || !draft || !data) return <Skeleton height={220} />;
  const set = <K extends keyof AutomationConfig>(key: K, value: AutomationConfig[K]) => setDraft({ ...draft, [key]: value });
  const toggleChannel = (id: AutomationConfig['deliveryChannels'][number]) =>
    set('deliveryChannels', draft.deliveryChannels.includes(id) ? draft.deliveryChannels.filter((c) => c !== id) : [...draft.deliveryChannels, id]);

  return (
    <SettingsSection
      title="Automation"
      description="Each employee's To-Do is collected automatically, and their end-of-day report is generated and emailed at the time below, in your business timezone."
      icon={<FiClock />}
      actions={<Switch checked={draft.enabled} onChange={(v) => set('enabled', v)} ariaLabel="Automation enabled" />}
      footer={
        <Button type="button" loading={save.isPending} onClick={() => save.mutate(draft)}>
          Save settings
        </Button>
      }
    >
      <div className={work.formGrid}>
        <SettingsField label="End-of-day time" hint="Reports are generated at this local time.">
          <Input type="time" aria-label="End-of-day time" value={draft.eodTime} onChange={(e) => set('eodTime', e.target.value)} />
        </SettingsField>
        <SettingsField label="Timezone" hint={`Currently using ${data.effectiveTimezone}. Leave on "Organization default" to follow your business timezone.`}>
          <select className={work.select} aria-label="Timezone" value={draft.timezone} onChange={(e) => set('timezone', e.target.value)}>
            <option value="">Organization default</option>
            {draft.timezone && !isKnownTimezone(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
            {TIMEZONE_GROUPS.map(([region, zones]) => (
              <optgroup key={region} label={region}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </SettingsField>
        {NUMBER_FIELDS.map((f) => (
          <SettingsField key={f.key} label={f.label} hint={f.hint}>
            <Input type="number" min={0} aria-label={f.label} value={String(draft[f.key])} onChange={(e) => set(f.key, Number(e.target.value) as never)} />
          </SettingsField>
        ))}
      </div>

      <SettingsField label="Where tasks come from" hint="Only sources whose assignee can be verified are offered.">
        <div className={work.channelRow}>
          {(data.sources ?? []).map((s) => (
            <Switch
              key={s.id}
              label={s.label}
              description={s.description}
              checked={draft.enabledSources.includes(s.id)}
              onChange={(on) => set('enabledSources', on ? [...draft.enabledSources, s.id] : draft.enabledSources.filter((x) => x !== s.id))}
            />
          ))}
        </div>
      </SettingsField>

      {(data.unsupported ?? []).length > 0 && (
        <SettingsField label="Not available as sources" hint="These cannot be collected from today, and why — nothing is guessed or made up for them.">
          {(data.unsupported ?? []).map((u) => (
            <div key={u.id} className={work.note} data-testid="unsupported-source">
              <strong>{u.label}.</strong> {u.reason}
            </div>
          ))}
        </SettingsField>
      )}

      <SettingsField label="Email delivery" hint="Tried in this order. The report is sent from the employee's own connected mailbox when it can send; SMTP is the fallback.">
        <div className={work.channelRow}>
          {CHANNELS.map((c) => (
            <Switch key={c.id} label={c.label} checked={draft.deliveryChannels.includes(c.id)} onChange={() => toggleChannel(c.id)} />
          ))}
        </div>
        <Switch label="Also send each report to the employee's reporting manager" checked={draft.sendToManager} onChange={(v) => set('sendToManager', v)} />
      </SettingsField>
    </SettingsSection>
  );
}

function MonitorSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['work-sync-status'], queryFn: () => workAutomationService.syncStatus(), refetchInterval: 30_000 });
  const run = useMutation({
    mutationFn: () => workAutomationService.runSync(),
    onSuccess: () => {
      toast.success('Synchronization finished.');
      void queryClient.invalidateQueries({ queryKey: ['work-sync-status'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });
  const eod = useMutation({
    mutationFn: () => workAutomationService.runEod(),
    onSuccess: (r) => {
      toast.success(r.skipped ? `Nothing to do (${r.skipped.replace(/_/g, ' ')}).` : `${r.generated} report(s) generated, ${r.delivered} email(s) sent.`);
      void queryClient.invalidateQueries({ queryKey: ['work-team'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  return (
    <SettingsSection
      title="Synchronization status"
      description="When each connected source last refreshed, and whether it worked."
      icon={<FiRefreshCw />}
      actions={
        <div className={work.inline}>
          <Button type="button" variant="outline" size="sm" loading={run.isPending} onClick={() => run.mutate()}>
            Sync now
          </Button>
          <Button type="button" variant="outline" size="sm" leftIcon={<FiSend />} loading={eod.isPending} onClick={() => eod.mutate()}>
            Generate today's EOD now
          </Button>
        </div>
      }
    >
      {isLoading || !data ? (
        <Skeleton height={100} />
      ) : (
        <table className={work.table}>
          <thead>
            <tr>
              <th>Source</th>
              <th>Last run</th>
              <th>Result</th>
              <th className={work.num}>Collected</th>
              <th className={work.num}>New</th>
              <th className={work.num}>Completed</th>
            </tr>
          </thead>
          <tbody>
            {data.adapters.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.label} {!a.enabled && <Badge>Off</Badge>}
                </td>
                <td>{a.last ? new Date(a.last.finishedAt).toLocaleString() : 'Never'}</td>
                <td>
                  {a.last ? (
                    <>
                      <Badge variant={a.last.status === 'ok' ? 'success' : a.last.status === 'partial' ? 'warning' : 'danger'}>{a.last.status}</Badge>
                      {a.last.error && <div className={work.error}>{a.last.error}</div>}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={work.num}>{a.last?.fetched ?? 0}</td>
                <td className={work.num}>{a.last?.created ?? 0}</td>
                <td className={work.num}>{a.last?.completed ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsSection>
  );
}

function IdentitiesSection({ people }: { people: HierarchyPerson[] }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['work-identities', 'unresolved'], queryFn: () => workAutomationService.identities('unresolved') });
  const [choice, setChoice] = useState<Record<string, string>>({});
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['work-identities'] });
  const link = useMutation({
    mutationFn: (v: { id: string; userId: string }) => workAutomationService.linkIdentity(v.id, v.userId),
    onSuccess: refresh,
    onError: (err) => toast.error(extractErrorMessage(err)),
  });
  const ignore = useMutation({ mutationFn: (id: string) => workAutomationService.ignoreIdentity(id), onSuccess: refresh, onError: (err) => toast.error(extractErrorMessage(err)) });

  const rows: IdentityRow[] = data ?? [];
  return (
    <SettingsSection
      title="Unmatched assignments"
      description="People in your connected platforms who could not be matched to an employee by verified email. Their work is not assigned to anyone until you resolve it — names are never matched automatically."
      icon={<FiUsers />}
    >
      {rows.length === 0 ? (
        <EmptyState compact title="Everything is matched" description="Platform users that can't be matched to an employee will be listed here." />
      ) : (
        <table className={work.table}>
          <thead>
            <tr>
              <th>Platform</th>
              <th>Platform user</th>
              <th>Seen</th>
              <th>Employee</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{platformLabel(r.platform)}</td>
                <td>
                  {r.externalName ?? r.externalUserId}
                  <div className={work.meta}>{r.externalEmail ?? r.externalUserId}</div>
                </td>
                <td className={work.num}>{r.seenCount}</td>
                <td>
                  <select className={work.select} aria-label={`Employee for ${r.externalUserId}`} value={choice[r.id] ?? ''} onChange={(e) => setChoice({ ...choice, [r.id]: e.target.value })}>
                    <option value="">Choose employee…</option>
                    {people
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <div className={work.actions}>
                    <Button type="button" size="sm" disabled={!choice[r.id]} onClick={() => link.mutate({ id: r.id, userId: choice[r.id] })}>
                      Link
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => ignore.mutate(r.id)}>
                      Not an employee
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsSection>
  );
}

function HierarchySection({ people }: { people: HierarchyPerson[] }) {
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (v: { userId: string; managerId: string | null }) => workAutomationService.setManager(v.userId, v.managerId),
    onSuccess: () => {
      toast.success('Reporting manager updated.');
      void queryClient.invalidateQueries({ queryKey: ['work-hierarchy'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  return (
    <SettingsSection
      title="Reporting managers"
      description="Each employee's end-of-day report is also emailed to their reporting manager. Only an active person of this business can be chosen, and reporting loops are blocked."
      icon={<FiUsers />}
    >
      <table className={work.table}>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Reports to</th>
          </tr>
        </thead>
        <tbody>
          {people
            .filter((p) => p.active)
            .map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  <div className={work.meta}>{p.email}</div>
                </td>
                <td>
                  <select
                    className={work.select}
                    aria-label={`Reporting manager of ${p.name}`}
                    value={p.reportingManagerId ?? ''}
                    disabled={set.isPending}
                    onChange={(e) => set.mutate({ userId: p.id, managerId: e.target.value || null })}
                  >
                    <option value="">No manager</option>
                    {managerCandidates(people, p.id).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </SettingsSection>
  );
}

export function WorkAutomationSettings() {
  const { data: people } = useQuery({ queryKey: ['work-hierarchy'], queryFn: () => workAutomationService.hierarchy() });
  return (
    <>
      <ConfigSection />
      <MonitorSection />
      <HierarchySection people={people ?? []} />
      <IdentitiesSection people={people ?? []} />
    </>
  );
}
