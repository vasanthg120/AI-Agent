import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiAlertTriangle, FiBell, FiCalendar, FiClock, FiGlobe } from 'react-icons/fi';
import { Badge, Button, Input, Skeleton, StringListEditor, Switch } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import {
  emailSlaService,
  type BusinessHoursConfig,
  type EmailEscalationRule,
  type EmailSlaPolicy,
} from '@/services/emailSlaService';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import styles from './EmailSlaSettings.module.css';

// EmailIntelligenceItem.priority is always one of these four (see
// emailIntelligenceService.ts) — the SLA policy/escalation UI below is
// scoped to exactly this fixed set rather than a free-text priority field.
const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
const DEFAULT_MINUTES: Record<string, number> = { urgent: 30, high: 120, medium: 480, low: 1440 };

// Purely a display choice (badge color per priority) — matches the severity
// ordering already used for these same four values elsewhere in the app.
const PRIORITY_BADGE: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

// Display-only translation of a raw minutes value into the phrase a human
// would actually say — never sent to the backend, purely so admins don't
// have to do the arithmetic themselves while tuning a policy or delay.
function formatDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return 'Immediately';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  if (totalMinutes % 1440 === 0) {
    const days = totalMinutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (totalMinutes % 60 === 0) {
    const hours = totalMinutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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
      toast.success(`${capitalize(priority)} SLA saved`);
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

  const sortedWorkingDays = hoursDraft.workingDays.slice().sort((a, b) => a - b);

  return (
    <>
      <SettingsSection
        title="Response Time Policies"
        description="How long employees have to send a first reply before an email is considered breached, per priority. Falls back to sensible defaults until saved here."
      >
        <div className={styles.policyGrid}>
          {PRIORITIES.map((p) => {
            const draft = policyDraft[p];
            if (!draft) return null;
            return (
              <div key={p} className={styles.policyCard}>
                <div className={styles.policyCardHeader}>
                  <Badge variant={PRIORITY_BADGE[p]}>{p}</Badge>
                  {!policies[p] && <span className={styles.defaultHint}>Using default</span>}
                </div>

                <SettingsField label="First response due (minutes)">
                  <Input
                    type="number"
                    min={1}
                    leftIcon={<FiClock size={14} />}
                    hint={`≈ ${formatDuration(draft.minutes)}`}
                    value={draft.minutes}
                    onChange={(e) =>
                      setPolicyDraft((prev) => ({ ...prev, [p]: { ...prev[p]!, minutes: Number(e.target.value) || 1 } }))
                    }
                  />
                </SettingsField>

                <div className={styles.policySwitches}>
                  <Switch
                    label="Business hours only"
                    description="Pause the clock outside working hours and holidays"
                    checked={draft.businessHoursEnabled}
                    onChange={(v) => setPolicyDraft((prev) => ({ ...prev, [p]: { ...prev[p]!, businessHoursEnabled: v } }))}
                  />
                  <Switch
                    label="Policy enabled"
                    description="Off — this priority is never tracked for breaches"
                    checked={draft.enabled}
                    onChange={(v) => setPolicyDraft((prev) => ({ ...prev, [p]: { ...prev[p]!, enabled: v } }))}
                  />
                </div>

                <div className={styles.policyCardFooter}>
                  <Button variant="secondary" size="sm" loading={saving === `policy-${p}`} onClick={() => savePolicy(p)}>
                    Save {capitalize(p)}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Business Hours"
        description="Used to calculate SLA due times when 'business hours only' is on above — non-working days/hours don't count toward the clock."
      >
        <div className={styles.hoursGrid}>
          <SettingsField label="Timezone">
            <Input
              leftIcon={<FiGlobe size={14} />}
              value={hoursDraft.timezone}
              placeholder="Asia/Kolkata"
              hint="IANA timezone name"
              onChange={(e) => setHoursDraft((prev) => ({ ...prev, timezone: e.target.value }))}
            />
          </SettingsField>
          <SettingsField label="Start time">
            <Input
              type="time"
              leftIcon={<FiClock size={14} />}
              value={hoursDraft.workingStartTime}
              onChange={(e) => setHoursDraft((prev) => ({ ...prev, workingStartTime: e.target.value }))}
            />
          </SettingsField>
          <SettingsField label="End time">
            <Input
              type="time"
              leftIcon={<FiClock size={14} />}
              value={hoursDraft.workingEndTime}
              onChange={(e) => setHoursDraft((prev) => ({ ...prev, workingEndTime: e.target.value }))}
            />
          </SettingsField>
        </div>

        <SettingsField label="Working days">
          <div className={styles.dayRow}>
            {WEEKDAY_LABELS.map((label, day) => (
              <button
                type="button"
                key={label}
                title={WEEKDAY_FULL[day]}
                className={hoursDraft.workingDays.includes(day) ? styles.dayChipActive : styles.dayChip}
                onClick={() => toggleWorkingDay(day)}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingsField>

        <StringListEditor
          label="Holidays (YYYY-MM-DD)"
          items={hoursDraft.holidays}
          onChange={(items) => setHoursDraft((prev) => ({ ...prev, holidays: items }))}
          addLabel="Add holiday"
        />

        <div className={styles.summaryBar}>
          <FiCalendar size={14} />
          {sortedWorkingDays.length === 0 ? (
            <span>No working days selected — a business-hours-only SLA will never advance.</span>
          ) : (
            <span>
              {sortedWorkingDays.map((d) => WEEKDAY_LABELS[d]).join(', ')} &middot; {hoursDraft.workingStartTime}–{hoursDraft.workingEndTime}{' '}
              &middot; {hoursDraft.timezone}
              {hoursDraft.holidays.length > 0 && ` · ${hoursDraft.holidays.length} holiday${hoursDraft.holidays.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>

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
                <th>Delay after breach</th>
                <th>Notifies</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} className={styles.emptyState}>
                    <FiAlertTriangle size={16} />
                    <span>No escalation rules configured yet — breaches will still be tracked, but no one is auto-notified.</span>
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <tr key={r._id}>
                    <td>
                      <Badge variant={PRIORITY_BADGE[r.priority] ?? 'neutral'}>{r.priority}</Badge>
                    </td>
                    <td>Level {r.escalationLevel}</td>
                    <td>{formatDuration(r.delayMinutes)}</td>
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

        <div className={styles.newRuleCard}>
          <span className={styles.newRuleTitle}>
            <FiBell size={14} />
            Add escalation level
          </span>
          <div className={styles.newRuleRow}>
            <SettingsField label="Priority">
              <select
                className={styles.select}
                value={newRule.priority}
                onChange={(e) => setNewRule((prev) => ({ ...prev, priority: e.target.value }))}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {capitalize(p)}
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsField label="Level">
              <Input
                type="number"
                min={1}
                value={newRule.escalationLevel}
                onChange={(e) => setNewRule((prev) => ({ ...prev, escalationLevel: Number(e.target.value) || 1 }))}
              />
            </SettingsField>
            <SettingsField label="Delay after breach (min)">
              <Input
                type="number"
                min={0}
                hint={formatDuration(newRule.delayMinutes)}
                value={newRule.delayMinutes}
                onChange={(e) => setNewRule((prev) => ({ ...prev, delayMinutes: Number(e.target.value) || 0 }))}
              />
            </SettingsField>
            <div className={styles.newRuleAction}>
              <Button variant="secondary" loading={saving === 'rule'} onClick={addRule}>
                Save Rule
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}
