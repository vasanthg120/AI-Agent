import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiAlertTriangle,
  FiBell,
  FiCalendar,
  FiCheck,
  FiClock,
  FiEdit2,
  FiGlobe,
  FiInbox,
  FiPlus,
  FiRotateCcw,
  FiX,
  FiZap,
} from 'react-icons/fi';
import { Badge, Button, EmptyState, Input, Skeleton, Switch } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { dayjs } from '@/utils/date';
import { DEVICE_TIMEZONE, TIMEZONE_GROUPS, isKnownTimezone, timeIn } from '@/utils/timezones';
import { emailSlaService, type EmailEscalationRule } from '@/services/emailSlaService';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import { DurationInput, formatDuration } from '../components/DurationInput';
import sectionStyles from '../components/SettingsSection.module.css';
import styles from './EmailSlaSettings.module.css';

// EmailIntelligenceItem.priority is always one of these four (see
// emailIntelligenceService.ts) — the SLA policy/escalation UI below is
// scoped to exactly this fixed set rather than a free-text priority field.
const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
type Priority = (typeof PRIORITIES)[number];
const DEFAULT_MINUTES: Record<Priority, number> = { urgent: 30, high: 120, medium: 480, low: 1440 };
const PRIORITY_BADGE: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };
const PRIORITY_HINT: Record<Priority, string> = {
  urgent: 'Complaints, outages, a customer waiting on you right now',
  high: 'New enquiries and quotes a customer is waiting for',
  medium: 'Normal back-and-forth with customers and vendors',
  low: 'FYIs and anything that can wait a day',
};

const RESPONSE_PRESETS = [
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
];
const DELAY_PRESETS = [
  { label: 'Right away', minutes: 0 },
  { label: '30 min', minutes: 30 },
  { label: '2 hours', minutes: 120 },
  { label: '1 day', minutes: 1440 },
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_PRESETS: { label: string; days: number[] }[] = [
  { label: 'Mon–Fri', days: [1, 2, 3, 4, 5] },
  { label: 'Mon–Sat', days: [1, 2, 3, 4, 5, 6] },
  { label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
];

interface PolicyDraft {
  minutes: number;
  businessHoursEnabled: boolean;
  enabled: boolean;
}

interface HoursDraft {
  timezone: string;
  workingDays: number[];
  workingStartTime: string;
  workingEndTime: string;
  holidays: string[];
}

// Matches EmailSlaPolicyService's own DEFAULT_BUSINESS_HOURS — GET
// /email-sla/business-hours returns an empty body for any org that hasn't
// configured this yet (the common case, including a brand-new org), so this
// form needs its own safe fallback rather than assuming the response is
// always a populated document.
const DEFAULT_HOURS: HoursDraft = {
  timezone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workingStartTime: '09:00',
  workingEndTime: '18:00',
  holidays: [],
};

interface RuleForm {
  priority: Priority;
  escalationLevel: number;
  delayMinutes: number;
  notifyAssignedUser: boolean;
  notifyManager: boolean;
  notifyAdmin: boolean;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function notifyList(r: Pick<EmailEscalationRule, 'notifyAssignedUser' | 'notifyManager' | 'notifyAdmin'>): string {
  return [r.notifyAssignedUser && 'Assigned person', r.notifyManager && 'Manager', r.notifyAdmin && 'Admin'].filter(Boolean).join(', ') || 'Nobody';
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function EmailSlaSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedPolicies, setSavedPolicies] = useState<Record<Priority, PolicyDraft & { exists: boolean }> | null>(null);
  const [policyDraft, setPolicyDraft] = useState<Record<Priority, PolicyDraft> | null>(null);
  const [savedHours, setSavedHours] = useState<HoursDraft>(DEFAULT_HOURS);
  const [hoursConfigured, setHoursConfigured] = useState(false);
  const [hoursDraft, setHoursDraft] = useState<HoursDraft>(DEFAULT_HOURS);
  const [holidayInput, setHolidayInput] = useState('');
  const [rules, setRules] = useState<EmailEscalationRule[]>([]);
  const [ruleForm, setRuleForm] = useState<RuleForm | null>(null);
  const [savingRule, setSavingRule] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [policyList, hoursConfig, ruleList] = await Promise.all([
          emailSlaService.listPolicies(),
          emailSlaService.getBusinessHours(),
          emailSlaService.listEscalationRules(),
        ]);
        const saved = {} as Record<Priority, PolicyDraft & { exists: boolean }>;
        const draft = {} as Record<Priority, PolicyDraft>;
        for (const p of PRIORITIES) {
          const found = policyList.find((row) => row.priority === p);
          const d = {
            minutes: found?.firstResponseTimeMinutes ?? DEFAULT_MINUTES[p],
            businessHoursEnabled: found?.businessHoursEnabled ?? true,
            enabled: found?.enabled ?? true,
          };
          saved[p] = { ...d, exists: !!found };
          draft[p] = d;
        }
        setSavedPolicies(saved);
        setPolicyDraft(draft);

        // An org that hasn't configured business hours yet gets back an empty
        // response body (axios turns this into '' — a falsy, non-null value —
        // not a real BusinessHoursConfig object).
        const has = !!hoursConfig && typeof hoursConfig === 'object';
        const h: HoursDraft = has
          ? {
              timezone: hoursConfig.timezone,
              workingDays: [...hoursConfig.workingDays].sort((a, b) => a - b),
              workingStartTime: hoursConfig.workingStartTime,
              workingEndTime: hoursConfig.workingEndTime,
              holidays: [...hoursConfig.holidays].sort(),
            }
          : { ...DEFAULT_HOURS, timezone: DEVICE_TIMEZONE };
        setHoursConfigured(has);
        setSavedHours(has ? h : DEFAULT_HOURS);
        setHoursDraft(h);
        setRules(ruleList);
      } catch (err) {
        toast.error(extractErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const dirtyPriorities = useMemo(
    () =>
      policyDraft && savedPolicies
        ? PRIORITIES.filter((p) => {
            const { exists: _exists, ...saved } = savedPolicies[p];
            return !sameJson(policyDraft[p], saved);
          })
        : [],
    [policyDraft, savedPolicies],
  );
  // A never-configured org's defaults count as a change once the timezone
  // was prefilled from this device, so "Save" actually creates the config.
  const hoursDirty = !sameJson(hoursDraft, savedHours) || (!hoursConfigured && hoursDraft.timezone !== savedHours.timezone);
  const hoursError =
    hoursDraft.workingEndTime <= hoursDraft.workingStartTime
      ? 'End time must be after start time'
      : hoursDraft.workingDays.length === 0
        ? 'Pick at least one working day'
        : null;
  const changeCount = dirtyPriorities.length + (hoursDirty ? 1 : 0);

  const setPolicy = (p: Priority, patch: Partial<PolicyDraft>) =>
    setPolicyDraft((prev) => (prev ? { ...prev, [p]: { ...prev[p], ...patch } } : prev));

  const discardAll = () => {
    if (savedPolicies) {
      const d = {} as Record<Priority, PolicyDraft>;
      for (const p of PRIORITIES) {
        const { exists: _exists, ...rest } = savedPolicies[p];
        d[p] = rest;
      }
      setPolicyDraft(d);
    }
    setHoursDraft(hoursConfigured ? savedHours : { ...DEFAULT_HOURS, timezone: DEVICE_TIMEZONE });
  };

  const saveAll = async () => {
    if (!policyDraft || !savedPolicies || (hoursDirty && hoursError)) return;
    setSaving(true);
    try {
      const results = await Promise.all(
        dirtyPriorities.map((p) =>
          emailSlaService.upsertPolicy({
            priority: p,
            firstResponseTimeMinutes: policyDraft[p].minutes,
            businessHoursEnabled: policyDraft[p].businessHoursEnabled,
            enabled: policyDraft[p].enabled,
          }),
        ),
      );
      if (results.length) {
        setSavedPolicies((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          for (const r of results) {
            next[r.priority as Priority] = {
              minutes: r.firstResponseTimeMinutes,
              businessHoursEnabled: r.businessHoursEnabled,
              enabled: r.enabled,
              exists: true,
            };
          }
          return next;
        });
      }
      if (hoursDirty) {
        const saved = await emailSlaService.upsertBusinessHours(hoursDraft);
        const h = {
          timezone: saved.timezone,
          workingDays: [...saved.workingDays].sort((a, b) => a - b),
          workingStartTime: saved.workingStartTime,
          workingEndTime: saved.workingEndTime,
          holidays: [...saved.holidays].sort(),
        };
        setSavedHours(h);
        setHoursDraft(h);
        setHoursConfigured(true);
      }
      toast.success('SLA settings saved');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const addHoliday = () => {
    if (!holidayInput) return;
    setHoursDraft((prev) =>
      prev.holidays.includes(holidayInput) ? prev : { ...prev, holidays: [...prev.holidays, holidayInput].sort() },
    );
    setHolidayInput('');
  };

  const rulesByPriority = useMemo(() => {
    const map = new Map<Priority, EmailEscalationRule[]>();
    for (const p of PRIORITIES) map.set(p, []);
    for (const r of rules) {
      const list = map.get(r.priority as Priority);
      if (list) list.push(r);
    }
    for (const list of map.values()) list.sort((a, b) => a.escalationLevel - b.escalationLevel);
    return map;
  }, [rules]);

  const openNewRule = (priority: Priority) => {
    const existing = rulesByPriority.get(priority) ?? [];
    const last = existing[existing.length - 1];
    setRuleForm({
      priority,
      escalationLevel: (last?.escalationLevel ?? 0) + 1,
      // Each level fires after the previous one by default, never before it.
      delayMinutes: last ? last.delayMinutes + 60 : 0,
      notifyAssignedUser: true,
      notifyManager: !!last,
      notifyAdmin: false,
    });
  };

  const openEditRule = (r: EmailEscalationRule) =>
    setRuleForm({
      priority: r.priority as Priority,
      escalationLevel: r.escalationLevel,
      delayMinutes: r.delayMinutes,
      notifyAssignedUser: r.notifyAssignedUser,
      notifyManager: r.notifyManager,
      notifyAdmin: r.notifyAdmin,
    });

  const storeRule = (saved: EmailEscalationRule) =>
    setRules((prev) => [...prev.filter((r) => !(r.priority === saved.priority && r.escalationLevel === saved.escalationLevel)), saved]);

  const saveRule = async () => {
    if (!ruleForm) return;
    setSavingRule('form');
    try {
      storeRule(await emailSlaService.upsertEscalationRule({ ...ruleForm, enabled: true }));
      toast.success(`${capitalize(ruleForm.priority)} · level ${ruleForm.escalationLevel} saved`);
      setRuleForm(null);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSavingRule(null);
    }
  };

  // Rules are keyed by priority+level server-side (upsert), so switching one
  // off/on is the same call with enabled flipped — there is no delete route.
  const toggleRule = async (r: EmailEscalationRule) => {
    setSavingRule(r._id);
    const optimistic = { ...r, enabled: !r.enabled };
    storeRule(optimistic);
    try {
      storeRule(
        await emailSlaService.upsertEscalationRule({
          priority: r.priority,
          escalationLevel: r.escalationLevel,
          delayMinutes: r.delayMinutes,
          notifyAssignedUser: r.notifyAssignedUser,
          notifyManager: r.notifyManager,
          notifyAdmin: r.notifyAdmin,
          enabled: !r.enabled,
        }),
      );
    } catch (err) {
      storeRule(r);
      toast.error(extractErrorMessage(err));
    } finally {
      setSavingRule(null);
    }
  };

  if (loading || !policyDraft || !savedPolicies) {
    return (
      <div className={styles.loading}>
        <Skeleton height={90} />
        <Skeleton height={320} />
        <Skeleton height={260} />
      </div>
    );
  }

  const ruleFormNoOne = ruleForm && !ruleForm.notifyAssignedUser && !ruleForm.notifyManager && !ruleForm.notifyAdmin;
  const editingExisting =
    ruleForm && rules.some((r) => r.priority === ruleForm.priority && r.escalationLevel === ruleForm.escalationLevel);

  return (
    <>
      {/* How it works — the whole feature in four steps, before any knobs. */}
      <div className={styles.flow}>
        {[
          { icon: FiInbox, title: 'Email arrives', text: 'The AI gives it a priority' },
          { icon: FiClock, title: 'Clock starts', text: 'Only in business hours, if you choose' },
          { icon: FiAlertTriangle, title: 'Deadline passes', text: 'No reply yet — it counts as breached' },
          { icon: FiBell, title: 'Escalation', text: 'The people you pick get notified' },
        ].map((step, i) => (
          <div key={step.title} className={styles.flowStep}>
            <span className={styles.flowIcon}>
              <step.icon />
            </span>
            <span className={styles.flowText}>
              <span className={styles.flowTitle}>
                {i + 1}. {step.title}
              </span>
              <span className={styles.flowSub}>{step.text}</span>
            </span>
          </div>
        ))}
      </div>

      <SettingsSection
        icon={<FiClock />}
        title="Response time per priority"
        description="How long someone has to send the first reply before an email counts as breached."
      >
        <div className={styles.policyGrid}>
          {PRIORITIES.map((p) => {
            const draft = policyDraft[p];
            const dirty = dirtyPriorities.includes(p);
            return (
              <div key={p} className={clsx(styles.policyCard, !draft.enabled && styles.policyOff, dirty && styles.policyDirty)}>
                <div className={styles.policyHeader}>
                  <Badge variant={PRIORITY_BADGE[p]}>{capitalize(p)}</Badge>
                  {dirty ? (
                    <span className={styles.changed}>Changed</span>
                  ) : (
                    !savedPolicies[p].exists && <span className={styles.defaultHint}>Default</span>
                  )}
                  <span className={styles.policyToggle}>
                    <Switch checked={draft.enabled} onChange={(v) => setPolicy(p, { enabled: v })} label="Track" />
                  </span>
                </div>
                <p className={styles.policyHint}>{PRIORITY_HINT[p]}</p>

                <div className={styles.policyBody}>
                  <span className={sectionStyles.fieldLabel}>Reply within</span>
                  <DurationInput
                    ariaLabel={`${p} first response time`}
                    value={draft.minutes}
                    min={1}
                    onChange={(m) => setPolicy(p, { minutes: m })}
                    presets={RESPONSE_PRESETS}
                    disabled={!draft.enabled}
                  />
                  <Switch
                    label="Business hours only"
                    description={draft.businessHoursEnabled ? 'Clock pauses nights, weekends and holidays' : 'Clock runs 24/7'}
                    checked={draft.businessHoursEnabled}
                    disabled={!draft.enabled}
                    onChange={(v) => setPolicy(p, { businessHoursEnabled: v })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<FiCalendar />}
        title="Business hours"
        description="When the clock runs for priorities set to 'business hours only'. Nights, non-working days and holidays don't count."
      >
        <div className={styles.hoursGrid}>
          <SettingsField label="Time zone">
            <select
              className={sectionStyles.select}
              value={hoursDraft.timezone}
              onChange={(e) => setHoursDraft((prev) => ({ ...prev, timezone: e.target.value }))}
            >
              {!isKnownTimezone(hoursDraft.timezone) && <option value={hoursDraft.timezone}>{hoursDraft.timezone}</option>}
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
            <span className={sectionStyles.fieldHint}>
              <FiGlobe /> It's {timeIn(hoursDraft.timezone, now)} there now
            </span>
          </SettingsField>
          <Input
            type="time"
            label="Opens"
            value={hoursDraft.workingStartTime}
            onChange={(e) => setHoursDraft((prev) => ({ ...prev, workingStartTime: e.target.value }))}
          />
          <Input
            type="time"
            label="Closes"
            value={hoursDraft.workingEndTime}
            error={hoursDraft.workingEndTime <= hoursDraft.workingStartTime ? 'Must be after opening time' : undefined}
            onChange={(e) => setHoursDraft((prev) => ({ ...prev, workingEndTime: e.target.value }))}
          />
        </div>

        <SettingsField label="Working days">
          <div className={styles.dayRow}>
            {WEEKDAY_LABELS.map((label, day) => {
              const on = hoursDraft.workingDays.includes(day);
              return (
                <button
                  type="button"
                  key={label}
                  title={WEEKDAY_FULL[day]}
                  aria-pressed={on}
                  className={clsx(styles.dayChip, on && styles.dayChipOn)}
                  onClick={() =>
                    setHoursDraft((prev) => ({
                      ...prev,
                      workingDays: on ? prev.workingDays.filter((d) => d !== day) : [...prev.workingDays, day].sort((a, b) => a - b),
                    }))
                  }
                >
                  {label}
                </button>
              );
            })}
            <span className={styles.dayDivider} />
            {DAY_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={clsx(styles.dayPreset, sameJson(hoursDraft.workingDays, preset.days) && styles.dayPresetOn)}
                onClick={() => setHoursDraft((prev) => ({ ...prev, workingDays: preset.days }))}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </SettingsField>

        <SettingsField label="Holidays">
          <div className={styles.holidayAdd}>
            <input
              type="date"
              className={styles.dateInput}
              value={holidayInput}
              onChange={(e) => setHolidayInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addHoliday()}
              aria-label="Holiday date"
            />
            <Button type="button" variant="secondary" size="sm" leftIcon={<FiPlus />} disabled={!holidayInput} onClick={addHoliday}>
              Add holiday
            </Button>
          </div>
          {hoursDraft.holidays.length > 0 && (
            <div className={styles.holidayList}>
              <AnimatePresence initial={false}>
                {hoursDraft.holidays.map((h) => {
                  const past = dayjs(h).isBefore(dayjs(), 'day');
                  return (
                    <motion.span
                      key={h}
                      className={clsx(styles.holiday, past && styles.holidayPast)}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.15 }}
                      title={past ? 'Already passed' : undefined}
                    >
                      {dayjs(h).isValid() ? dayjs(h).format('ddd, D MMM YYYY') : h}
                      <button
                        type="button"
                        className={styles.holidayRemove}
                        aria-label={`Remove ${h}`}
                        onClick={() => setHoursDraft((prev) => ({ ...prev, holidays: prev.holidays.filter((x) => x !== h) }))}
                      >
                        <FiX />
                      </button>
                    </motion.span>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </SettingsField>

        <div className={clsx(styles.summaryBar, hoursError && styles.summaryError)}>
          {hoursError ? <FiAlertTriangle /> : <FiCalendar />}
          <span>
            {hoursError ??
              `${hoursDraft.workingDays.map((d) => WEEKDAY_LABELS[d]).join(', ')} · ${hoursDraft.workingStartTime}–${hoursDraft.workingEndTime} · ${hoursDraft.timezone.replace(/_/g, ' ')}${
                hoursDraft.holidays.length ? ` · ${hoursDraft.holidays.length} holiday${hoursDraft.holidays.length === 1 ? '' : 's'}` : ''
              }`}
          </span>
          {!hoursConfigured && !hoursError && <span className={styles.defaultHint}>Not saved yet — using defaults</span>}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<FiAlertTriangle />}
        title="Escalation"
        description="What happens when a deadline is missed. Each level notifies more people the longer an email stays unanswered. Changes here save right away."
      >
        <div className={styles.ladders}>
          {PRIORITIES.map((p) => {
            const list = rulesByPriority.get(p) ?? [];
            return (
              <div key={p} className={styles.ladder}>
                <div className={styles.ladderHead}>
                  <Badge variant={PRIORITY_BADGE[p]}>{capitalize(p)}</Badge>
                  <span className={styles.ladderMeta}>
                    Deadline {policyDraft[p].enabled ? formatDuration(policyDraft[p].minutes) : 'not tracked'}
                  </span>
                </div>
                <div className={styles.steps}>
                  <span className={styles.stepStart}>
                    <FiZap /> Breach
                  </span>
                  {list.map((r) => (
                    <motion.div key={r._id} className={clsx(styles.step, !r.enabled && styles.stepOff)}>
                      <span className={styles.stepConnector} aria-hidden />
                      <button type="button" className={styles.stepBody} onClick={() => openEditRule(r)} title="Edit this level">
                        <span className={styles.stepLevel}>Level {r.escalationLevel}</span>
                        <span className={styles.stepWhen}>{r.delayMinutes === 0 ? 'Right away' : `+${formatDuration(r.delayMinutes)}`}</span>
                        <span className={styles.stepWho}>{notifyList(r)}</span>
                        <FiEdit2 className={styles.stepEdit} aria-hidden />
                      </button>
                      <Switch
                        checked={r.enabled}
                        disabled={savingRule === r._id}
                        onChange={() => void toggleRule(r)}
                        label={r.enabled ? 'On' : 'Off'}
                      />
                    </motion.div>
                  ))}
                  <button type="button" className={styles.addStep} onClick={() => openNewRule(p)}>
                    <FiPlus /> {list.length ? 'Add level' : 'Add first level'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {rules.length === 0 && (
          <EmptyState
            compact
            icon={FiBell}
            title="No escalations yet"
            description="Breaches are still tracked, but nobody is notified automatically. Add a first level to a priority above."
          />
        )}

        <AnimatePresence>
          {ruleForm && (
            <motion.div
              className={styles.ruleForm}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className={styles.ruleFormInner}>
                <div className={styles.ruleFormHead}>
                  <span className={styles.ruleFormTitle}>
                    <FiBell /> {editingExisting ? 'Edit' : 'New'} escalation · {capitalize(ruleForm.priority)} · level {ruleForm.escalationLevel}
                  </span>
                  <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setRuleForm(null)}>
                    <FiX />
                  </button>
                </div>

                <div className={styles.ruleGrid}>
                  <SettingsField label="Priority">
                    <select
                      className={sectionStyles.select}
                      value={ruleForm.priority}
                      onChange={(e) => setRuleForm((f) => (f ? { ...f, priority: e.target.value as Priority } : f))}
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {capitalize(p)}
                        </option>
                      ))}
                    </select>
                  </SettingsField>
                  <Input
                    type="number"
                    min={1}
                    label="Level"
                    value={ruleForm.escalationLevel}
                    onChange={(e) => setRuleForm((f) => (f ? { ...f, escalationLevel: Math.max(1, Number(e.target.value) || 1) } : f))}
                  />
                  <div className={styles.ruleWide}>
                    <span className={sectionStyles.fieldLabel}>Notify this long after the deadline is missed</span>
                    <DurationInput
                      ariaLabel="Delay after breach"
                      value={ruleForm.delayMinutes}
                      onChange={(m) => setRuleForm((f) => (f ? { ...f, delayMinutes: m } : f))}
                      presets={DELAY_PRESETS}
                    />
                  </div>
                </div>

                <div>
                  <span className={sectionStyles.fieldLabel}>Who gets notified</span>
                  <div className={styles.notifyRow}>
                    {(
                      [
                        ['notifyAssignedUser', 'Assigned person', 'Whoever the email belongs to'],
                        ['notifyManager', 'Their manager', 'The store manager'],
                        ['notifyAdmin', 'Admins', 'Everyone with the admin role'],
                      ] as const
                    ).map(([key, label, hint]) => (
                      <label key={key} className={clsx(styles.notifyOption, ruleForm[key] && styles.notifyOn)}>
                        <input
                          type="checkbox"
                          checked={ruleForm[key]}
                          onChange={(e) => setRuleForm((f) => (f ? { ...f, [key]: e.target.checked } : f))}
                        />
                        <span className={styles.notifyCheck}>{ruleForm[key] && <FiCheck />}</span>
                        <span className={styles.notifyText}>
                          <span className={styles.notifyLabel}>{label}</span>
                          <span className={styles.notifyHint}>{hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {ruleFormNoOne && <span className={styles.formError}>Pick at least one person to notify.</span>}
                </div>

                <div className={styles.ruleFormFoot}>
                  <span className={styles.ruleSentence}>
                    If a <strong>{ruleForm.priority}</strong> email is still unanswered{' '}
                    <strong>{ruleForm.delayMinutes === 0 ? 'the moment' : `${formatDuration(ruleForm.delayMinutes)} after`}</strong> its deadline,
                    notify <strong>{notifyList(ruleForm).toLowerCase()}</strong>.
                  </span>
                  <div className={styles.ruleFormActions}>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRuleForm(null)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      leftIcon={<FiCheck />}
                      loading={savingRule === 'form'}
                      disabled={!!ruleFormNoOne}
                      onClick={() => void saveRule()}
                    >
                      {editingExisting ? 'Update level' : 'Add level'}
                    </Button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </SettingsSection>

      <AnimatePresence>
        {changeCount > 0 && (
          <motion.div
            className={styles.saveBar}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <span className={styles.saveBarText}>
              <span className={styles.saveBarDot} />
              {changeCount} unsaved change{changeCount === 1 ? '' : 's'}
              {hoursDirty && hoursError && <span className={styles.saveBarError}> — {hoursError}</span>}
            </span>
            <div className={styles.saveBarActions}>
              <Button type="button" variant="ghost" size="sm" leftIcon={<FiRotateCcw />} disabled={saving} onClick={discardAll}>
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                leftIcon={<FiCheck />}
                loading={saving}
                disabled={saving || (hoursDirty && !!hoursError)}
                onClick={() => void saveAll()}
              >
                Save changes
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
