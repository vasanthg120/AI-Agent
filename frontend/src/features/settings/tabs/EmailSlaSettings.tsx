import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, Input, Skeleton, StringListEditor, Switch } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import {
  emailSlaService,
  type BusinessHoursConfig,
  type EmailEscalationRule,
  type EmailSlaPolicy,
} from '@/services/emailSlaService';
import { SettingsSection } from '../components/SettingsSection';
import styles from './EmailSlaSettings.module.css';

// EmailIntelligenceItem.priority is always one of these four (see
// emailIntelligenceService.ts) — the SLA policy/escalation UI below is
// scoped to exactly this fixed set rather than a free-text priority field.
const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
const DEFAULT_MINUTES: Record<string, number> = { urgent: 30, high: 120, medium: 480, low: 1440 };

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Matches EmailSlaPolicyService's own DEFAULT_BUSINESS_HOURS — GET
// /email-sla/business-hours returns an empty body for any org that hasn't
// configured this yet (the common case, including a brand-new org), so this
// form needs its own safe fallback rather than assuming the response is
// always a populated document.
const DEFAULT_HOURS_DRAFT = {
  timezone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workingStartTime: '09:00',
  workingEndTime: '18:00',
  holidays: [] as string[],
};

export function EmailSlaSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [policies, setPolicies] = useState<Record<string, EmailSlaPolicy | undefined>>({});
  const [policyDraft, setPolicyDraft] = useState<Record<string, { minutes: number; businessHoursEnabled: boolean; enabled: boolean }>>({});
  const [hours, setHours] = useState<BusinessHoursConfig | null>(null);
  const [hoursDraft, setHoursDraft] = useState(DEFAULT_HOURS_DRAFT);
  const [rules, setRules] = useState<EmailEscalationRule[]>([]);
  const [newRule, setNewRule] = useState({ priority: 'urgent', escalationLevel: 1, delayMinutes: 0 });

  const load = async () => {
    setLoading(true);
    try {
      const [policyList, hoursConfig, ruleList] = await Promise.all([
        emailSlaService.listPolicies(),
        emailSlaService.getBusinessHours(),
        emailSlaService.listEscalationRules(),
      ]);

      const byPriority: Record<string, EmailSlaPolicy | undefined> = {};
      const draft: Record<string, { minutes: number; businessHoursEnabled: boolean; enabled: boolean }> = {};
      for (const p of PRIORITIES) {
        const found = policyList.find((row) => row.priority === p);
        byPriority[p] = found;
        draft[p] = {
          minutes: found?.firstResponseTimeMinutes ?? DEFAULT_MINUTES[p],
          businessHoursEnabled: found?.businessHoursEnabled ?? true,
          enabled: found?.enabled ?? true,
        };
      }
      setPolicies(byPriority);
      setPolicyDraft(draft);

      // An org that hasn't configured business hours yet gets back an empty
      // response body (axios turns this into '' — a falsy, non-null value —
      // not a real BusinessHoursConfig object), so this can't be trusted to
      // always carry every field.
      const hasHoursConfig = !!hoursConfig && typeof hoursConfig === 'object';
      setHours(hasHoursConfig ? hoursConfig : null);
      setHoursDraft(
        hasHoursConfig
          ? {
              timezone: hoursConfig.timezone,
              workingDays: hoursConfig.workingDays,
              workingStartTime: hoursConfig.workingStartTime,
              workingEndTime: hoursConfig.workingEndTime,
              holidays: hoursConfig.holidays,
            }
          : DEFAULT_HOURS_DRAFT,
      );

      setRules(ruleList);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const savePolicy = async (priority: string) => {
    const draft = policyDraft[priority];
    if (!draft) return;
    setSaving(`policy-${priority}`);
    try {
      const saved = await emailSlaService.upsertPolicy({
        priority,
        firstResponseTimeMinutes: draft.minutes,
        businessHoursEnabled: draft.businessHoursEnabled,
        enabled: draft.enabled,
      });
      setPolicies((prev) => ({ ...prev, [priority]: saved }));
      toast.success(`${priority} SLA saved`);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const toggleWorkingDay = (day: number) => {
    setHoursDraft((prev) => ({
      ...prev,
      workingDays: prev.workingDays.includes(day) ? prev.workingDays.filter((d) => d !== day) : [...prev.workingDays, day].sort(),
    }));
  };

  const saveHours = async () => {
    setSaving('hours');
    try {
      const saved = await emailSlaService.upsertBusinessHours(hoursDraft);
      setHours(saved);
      toast.success('Business hours saved');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const addRule = async () => {
    setSaving('rule');
    try {
      const saved = await emailSlaService.upsertEscalationRule({
        priority: newRule.priority,
        escalationLevel: newRule.escalationLevel,
        delayMinutes: newRule.delayMinutes,
      });
      setRules((prev) => {
        const withoutExisting = prev.filter((r) => !(r.priority === saved.priority && r.escalationLevel === saved.escalationLevel));
        return [...withoutExisting, saved].sort((a, b) => a.priority.localeCompare(b.priority) || a.escalationLevel - b.escalationLevel);
      });
      toast.success('Escalation rule saved');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <Skeleton height={400} />;

  return (
    <>
      <SettingsSection
        title="Response Time Policies"
        description="How long employees have to send a first reply before an email is considered breached, per priority. Falls back to sensible defaults until saved here."
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Priority</th>
                <th>First response due (minutes)</th>
                <th>Business hours only</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((p) => {
                const draft = policyDraft[p];
                if (!draft) return null;
                return (
                  <tr key={p}>
                    <td>
                      <Badge variant={p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : 'neutral'}>{p}</Badge>
                      {!policies[p] && <span className={styles.defaultHint}> (using default)</span>}
                    </td>
                    <td>
                      <Input
                        type="number"
                        min={1}
                        value={draft.minutes}
                        onChange={(e) =>
                          setPolicyDraft((prev) => ({ ...prev, [p]: { ...prev[p]!, minutes: Number(e.target.value) || 1 } }))
                        }
                      />
                    </td>
                    <td>
                      <Switch
                        checked={draft.businessHoursEnabled}
                        onChange={(v) => setPolicyDraft((prev) => ({ ...prev, [p]: { ...prev[p]!, businessHoursEnabled: v } }))}
                      />
                    </td>
                    <td>
                      <Switch checked={draft.enabled} onChange={(v) => setPolicyDraft((prev) => ({ ...prev, [p]: { ...prev[p]!, enabled: v } }))} />
                    </td>
                    <td>
                      <Button variant="secondary" size="sm" loading={saving === `policy-${p}`} onClick={() => savePolicy(p)}>
                        Save
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Business Hours"
        description="Used to calculate SLA due times when 'business hours only' is on above — non-working days/hours don't count toward the clock."
      >
        <div className={styles.hoursGrid}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Timezone (IANA name)</span>
            <Input
              value={hoursDraft.timezone}
              placeholder="Asia/Kolkata"
              onChange={(e) => setHoursDraft((prev) => ({ ...prev, timezone: e.target.value }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Start time</span>
            <Input
              type="time"
              value={hoursDraft.workingStartTime}
              onChange={(e) => setHoursDraft((prev) => ({ ...prev, workingStartTime: e.target.value }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>End time</span>
            <Input
              type="time"
              value={hoursDraft.workingEndTime}
              onChange={(e) => setHoursDraft((prev) => ({ ...prev, workingEndTime: e.target.value }))}
            />
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Working days</span>
          <div className={styles.dayRow}>
            {WEEKDAY_LABELS.map((label, day) => (
              <button
                type="button"
                key={label}
                className={hoursDraft.workingDays.includes(day) ? styles.dayChipActive : styles.dayChip}
                onClick={() => toggleWorkingDay(day)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <StringListEditor
          label="Holidays (YYYY-MM-DD)"
          items={hoursDraft.holidays}
          onChange={(items) => setHoursDraft((prev) => ({ ...prev, holidays: items }))}
          addLabel="Add holiday"
        />

        <div className={styles.footer}>
          <Button variant="primary" loading={saving === 'hours'} onClick={saveHours}>
            Save Business Hours
          </Button>
        </div>
        {hours && <p className={styles.defaultHint}>Currently applies to every priority with "business hours only" enabled.</p>}
      </SettingsSection>

      <SettingsSection
        title="Escalation Rules"
        description="When a priority's SLA is breached and stays unresolved, escalation levels notify additional people the longer it stays open. Level 1 can fire immediately (delay of 0 minutes)."
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Level</th>
                <th>Delay after breach (minutes)</th>
                <th>Notifies</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} className={styles.emptyState}>
                    No escalation rules configured yet — breaches will still be tracked, but no one is auto-notified.
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <tr key={r._id}>
                    <td>{r.priority}</td>
                    <td>{r.escalationLevel}</td>
                    <td>{r.delayMinutes}</td>
                    <td>
                      {[r.notifyAssignedUser && 'Assigned user', r.notifyManager && 'Manager', r.notifyAdmin && 'Admin']
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className={styles.newRuleRow}>
          <select
            className={styles.select}
            value={newRule.priority}
            onChange={(e) => setNewRule((prev) => ({ ...prev, priority: e.target.value }))}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <Input
            type="number"
            min={1}
            value={newRule.escalationLevel}
            onChange={(e) => setNewRule((prev) => ({ ...prev, escalationLevel: Number(e.target.value) || 1 }))}
            placeholder="Level"
          />
          <Input
            type="number"
            min={0}
            value={newRule.delayMinutes}
            onChange={(e) => setNewRule((prev) => ({ ...prev, delayMinutes: Number(e.target.value) || 0 }))}
            placeholder="Delay (min)"
          />
          <Button variant="secondary" loading={saving === 'rule'} onClick={addRule}>
            Save Rule
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}
