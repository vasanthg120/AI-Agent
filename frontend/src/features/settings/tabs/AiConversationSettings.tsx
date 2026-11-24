import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiBell, FiClock, FiHelpCircle, FiMic, FiPlus, FiRotateCcw, FiSun, FiTrash2 } from 'react-icons/fi';
import { Button, Skeleton, Switch } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import {
  METRICS,
  assistantService,
  type AiConversationSettings,
  type ConversationSettingsView,
  type Greeting,
  type Metric,
  type SpeakingStyle,
} from '@/services/assistantService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { useAssistantStore } from '@/stores/assistantStore';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import sectionStyles from '../components/SettingsSection.module.css';
import { ChipRadioGroup } from './voice/ChipRadioGroup';
import styles from './AiConversationSettings.module.css';

const GREETING_OPTIONS: { value: Greeting; label: string; title: string }[] = [
  { value: 'first_of_day', label: 'First sign-in of the day', title: 'Greets you out loud once a day' },
  { value: 'every_login', label: 'Every sign-in', title: 'Greets you each time you sign in' },
  { value: 'tap', label: 'Only when I tap', title: 'Never speaks on its own — tap “Hear it”' },
];

const STYLE_OPTIONS: { value: SpeakingStyle; label: string; title: string }[] = [
  { value: 'concise', label: 'Short and to the point', title: 'About a minute' },
  { value: 'detailed', label: 'More detail', title: 'About a minute and a half, with more on why' },
];

const METRIC_LABEL: Record<Metric, string> = {
  revenue: 'Revenue',
  pipeline: 'Pipeline',
  quotations: 'Quotations',
  emails: 'Emails',
  calls: 'Calls',
  tasks: 'Tasks',
  team: 'Team',
  syncHealth: 'Sync health',
};

const DAY_LABEL = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAME = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MAX_SCHEDULES = 6;
const MAX_QUESTIONS = 12;

function listTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const values = intl.supportedValuesOf?.('timeZone');
    if (values?.length) return values;
  } catch {
    // Older browsers: the short list below.
  }
  return ['Asia/Kolkata', 'Australia/Sydney', 'Australia/Melbourne', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];
}
const TIME_ZONES = listTimeZones();

type Editing = 'me' | 'organization';

/** Inside quiet hours (which may run past midnight) — as the server decides it. */
function inQuietHours(quiet: AiConversationSettings['quietHours'], time: string): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end;
}

// AI Conversations — how Haive talks to you: whether it speaks, when it greets,
// in what language and how much, what it keeps an eye on, the questions it
// suggests, when it starts a conversation on its own, and when it stays quiet.
// Everyone sets their own; an owner or admin can also set the company default
// that everyone without their own follows.
export function AiConversationSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['assistant-settings'], queryFn: assistantService.getSettings, staleTime: 60_000 });
  const [editing, setEditing] = useState<Editing>('me');
  const [draft, setDraft] = useState<AiConversationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [newQuestion, setNewQuestion] = useState('');

  const baseline = useMemo(() => (data ? (editing === 'organization' ? (data.organization ?? data.defaults) : data.settings) : null), [data, editing]);
  // Reset the form only when what's saved really changed (a background refetch of the same settings keeps unsaved edits).
  const baselineKey = baseline ? JSON.stringify(baseline) : '';
  useEffect(() => {
    if (baselineKey) setDraft(JSON.parse(baselineKey) as AiConversationSettings);
  }, [baselineKey, editing]);

  const dirty = !!draft && !!baseline && JSON.stringify(draft) !== JSON.stringify(baseline);
  const set = <K extends keyof AiConversationSettings>(key: K, value: AiConversationSettings[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const applied = (view: ConversationSettingsView) => {
    queryClient.setQueryData(['assistant-settings'], view);
    useAssistantStore.getState().setSettings(view.settings);
    // Out of date, not rewritten now: the next time it's needed (a reload, coming back to the tab) it's written
    // from the new settings — once, however many times they save (the server reuses it if nothing it's written from changed).
    void queryClient.invalidateQueries({ queryKey: ['assistant-briefing'], refetchType: 'none' });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const view = editing === 'organization' ? await assistantService.saveOrganizationSettings(draft) : await assistantService.saveMySettings(draft);
      applied(view);
      toast.success(editing === 'organization' ? 'Company default saved' : 'Your AI Conversations settings are saved');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const resetMine = async () => {
    setSaving(true);
    try {
      applied(await assistantService.resetMySettings());
      toast.success(data?.organization ? 'Back to the company default' : 'Back to Haive’s standard settings');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || (!draft && !error)) {
    return (
      <div className={styles.page}>
        <Skeleton height={120} />
        <Skeleton height={220} />
      </div>
    );
  }
  if (error || !data || !draft) return <p className={styles.error}>{extractErrorMessage(error) || 'AI Conversations settings couldn’t be loaded.'}</p>;

  const addQuestion = () => {
    const text = newQuestion.replace(/\s+/g, ' ').trim();
    if (text.length < 3) return;
    if (draft.questions.some((q) => q.text.toLowerCase() === text.toLowerCase())) {
      toast('That question is already in the list.');
      return;
    }
    set('questions', [...draft.questions, { text, enabled: true }]);
    setNewQuestion('');
  };

  const setSchedule = (index: number, patch: Partial<AiConversationSettings['schedules'][number]>) =>
    set('schedules', draft.schedules.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        {data.canSetOrganization && (
          <ChipRadioGroup
            label="Whose settings"
            options={[
              { value: 'me', label: 'Just me' },
              { value: 'organization', label: 'Company default' },
            ]}
            value={editing}
            onChange={(v) => setEditing(v as Editing)}
            small
          />
        )}
        <p className={styles.source}>
          {editing === 'organization'
            ? 'The company default applies to everyone in this business who hasn’t set their own.'
            : data.source === 'mine'
              ? 'These are your own settings.'
              : data.source === 'organization'
                ? 'You’re following the company default — change anything below to make it your own.'
                : 'Haive’s standard settings — change anything below to make them your own.'}
          {editing === 'me' && data.source === 'mine' && (
            <button type="button" className={styles.linkButton} onClick={() => void resetMine()} disabled={saving}>
              <FiRotateCcw aria-hidden /> {data.organization ? 'Use the company default' : 'Use Haive’s standard settings'}
            </button>
          )}
        </p>
      </div>

      <SettingsSection icon={<FiMic />} title="Voice & greeting" description="Whether Haive talks out loud, when it greets you, and how it speaks.">
        <Switch
          label="Talk out loud"
          description="Off: Haive answers in text only — it never speaks, and its talk button is hidden."
          checked={draft.voiceEnabled}
          onChange={(v) => set('voiceEnabled', v)}
        />
        <SettingsField label="Greet me with my briefing" hint="Browsers only play sound after a click, so before that Haive shows “Your briefing is ready — Hear it”.">
          <ChipRadioGroup label="Greet me with my briefing" options={GREETING_OPTIONS} value={draft.greeting} onChange={(v) => set('greeting', v as Greeting)} disabled={!draft.voiceEnabled} />
        </SettingsField>
        <div className={styles.twoUp}>
          <SettingsField label="Language" hint="Haive listens, writes the briefing and speaks in this language.">
            <select className={sectionStyles.select} value={draft.language} onChange={(e) => set('language', e.target.value)} aria-label="Language">
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </SettingsField>
          <SettingsField label="How much to say">
            <ChipRadioGroup label="How much to say" options={STYLE_OPTIONS} value={draft.style} onChange={(v) => set('style', v as SpeakingStyle)} />
          </SettingsField>
        </div>
        <p className={styles.note}>
          The voice itself (and its accent) is chosen in <Link to={ROUTES.settingsVoice}>Voice &amp; Accent</Link>.
        </p>
      </SettingsSection>

      <SettingsSection icon={<FiSun />} title="Briefing" description="What Haive tells you when you sign in — from your own business’s figures, limited to what you’re allowed to see.">
        <Switch
          label="Prepare my briefing when I sign in"
          description="Off: Haive writes one only when you ask for it."
          checked={draft.briefingEnabled}
          onChange={(v) => set('briefingEnabled', v)}
        />
        <SettingsField label="What Haive keeps an eye on" hint="Anything switched off is left out of briefings and alerts.">
          <div className={styles.chips} role="group" aria-label="What Haive keeps an eye on">
            {METRICS.map((m) => (
              <button
                key={m}
                type="button"
                className={clsx(styles.chip, draft.metrics[m] && styles.chipOn)}
                aria-pressed={draft.metrics[m]}
                onClick={() => set('metrics', { ...draft.metrics, [m]: !draft.metrics[m] })}
              >
                {METRIC_LABEL[m]}
              </button>
            ))}
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection
        icon={<FiHelpCircle />}
        title="Questions Haive suggests"
        description="Shown as one-tap questions, and the briefing picks the ones today’s figures make worth asking."
        actions={
          <button type="button" className={styles.linkButton} onClick={() => set('questions', data.defaults.questions)}>
            <FiRotateCcw aria-hidden /> Suggested set
          </button>
        }
      >
        <ul className={styles.questionList}>
          {draft.questions.map((q, i) => (
            <li key={q.text} className={clsx(styles.question, !q.enabled && styles.questionOff)}>
              <Switch ariaLabel={`Suggest “${q.text}”`} checked={q.enabled} onChange={(v) => set('questions', draft.questions.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />
              <span className={styles.questionText}>{q.text}</span>
              <button type="button" className={styles.iconButton} aria-label={`Remove “${q.text}”`} onClick={() => set('questions', draft.questions.filter((_, j) => j !== i))}>
                <FiTrash2 aria-hidden />
              </button>
            </li>
          ))}
          {draft.questions.length === 0 && <li className={styles.empty}>No suggested questions — Haive won’t offer any.</li>}
        </ul>
        {draft.questions.length < MAX_QUESTIONS && (
          <form
            className={styles.addRow}
            onSubmit={(e) => {
              e.preventDefault();
              addQuestion();
            }}
          >
            <input
              className={styles.textInput}
              value={newQuestion}
              maxLength={120}
              onChange={(e) => setNewQuestion(e.target.value)}
              placeholder="Add your own, e.g. Which quotes expire this week?"
              aria-label="Add a question"
            />
            <Button type="submit" variant="outline" size="sm" leftIcon={<FiPlus />} disabled={newQuestion.trim().length < 3}>
              Add
            </Button>
          </form>
        )}
      </SettingsSection>

      <SettingsSection
        icon={<FiClock />}
        title="Scheduled conversations"
        description="At each time you get a notification with today’s headline figures (no AI cost); Haive writes the full briefing when you open it."
      >
        {draft.schedules.length === 0 && <p className={styles.empty}>None yet — Haive only briefs you when you sign in.</p>}
        {draft.schedules.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className={clsx(styles.schedule, !s.enabled && styles.scheduleOff)}>
            <div className={styles.scheduleTop}>
              <input className={clsx(styles.textInput, styles.scheduleLabel)} value={s.label} maxLength={40} onChange={(e) => setSchedule(i, { label: e.target.value })} aria-label="Name" />
              <input className={clsx(styles.textInput, styles.time)} type="time" value={s.time} onChange={(e) => e.target.value && setSchedule(i, { time: e.target.value })} aria-label={`${s.label} time`} />
              <Switch ariaLabel={`${s.label} on`} checked={s.enabled} onChange={(v) => setSchedule(i, { enabled: v })} />
              <button type="button" className={styles.iconButton} aria-label={`Remove ${s.label}`} onClick={() => set('schedules', draft.schedules.filter((_, j) => j !== i))}>
                <FiTrash2 aria-hidden />
              </button>
            </div>
            {s.enabled && inQuietHours(draft.quietHours, s.time) && (
              <p className={styles.warn}>
                {s.time} is inside your quiet hours ({draft.quietHours.start}–{draft.quietHours.end}), so it won’t be sent.
              </p>
            )}
            <div className={styles.days} role="group" aria-label={`${s.label} days`}>
              {DAY_LABEL.map((d, k) => {
                const day = k + 1;
                const on = s.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={clsx(styles.day, on && styles.chipOn)}
                    aria-pressed={on}
                    aria-label={DAY_NAME[k]}
                    title={DAY_NAME[k]}
                    // At least one day stays on.
                    onClick={() => (on && s.days.length === 1 ? undefined : setSchedule(i, { days: on ? s.days.filter((x) => x !== day) : [...s.days, day].sort() }))}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className={styles.scheduleActions}>
          {draft.schedules.length < MAX_SCHEDULES && (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<FiPlus />}
              onClick={() =>
                set('schedules', [
                  ...draft.schedules,
                  draft.schedules.length === 0
                    ? { label: 'Morning briefing', time: '09:00', days: [1, 2, 3, 4, 5], enabled: true }
                    : { label: 'End of day', time: '17:30', days: [1, 2, 3, 4, 5], enabled: true },
                ])
              }
            >
              Add a time
            </Button>
          )}
          <label className={styles.inline}>
            <span>Time zone</span>
            <select className={clsx(sectionStyles.select, styles.zone)} value={draft.timeZone ?? ''} onChange={(e) => set('timeZone', e.target.value || null)}>
              <option value="">The business’s own</option>
              {(draft.timeZone && !TIME_ZONES.includes(draft.timeZone) ? [draft.timeZone, ...TIME_ZONES] : TIME_ZONES).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
        </div>
      </SettingsSection>

      <SettingsSection icon={<FiBell />} title="Alerts, notifications & quiet hours" description="When Haive may start a conversation on its own, and how it reaches you.">
        <Switch
          label="Speak up when something needs attention"
          description="A new enquiry waiting too long, a mailbox or CRM that stopped syncing, deals past their closing date."
          checked={draft.alerts}
          onChange={(v) => set('alerts', v)}
        />
        <div className={styles.twoUp}>
          <Switch label="Bell in the app" checked={draft.notify.bell} onChange={(v) => set('notify', { ...draft.notify, bell: v })} />
          <Switch
            label="Push notification"
            description="Phone and desktop, as set in Notifications."
            checked={draft.notify.phone}
            onChange={(v) => set('notify', { ...draft.notify, phone: v })}
          />
        </div>
        <div className={styles.quiet}>
          <Switch
            label="Quiet hours"
            description="Nothing proactive in this window (your sign-in briefing still works)."
            checked={draft.quietHours.enabled}
            onChange={(v) => set('quietHours', { ...draft.quietHours, enabled: v })}
          />
          <div className={styles.quietTimes}>
            <input
              className={clsx(styles.textInput, styles.time)}
              type="time"
              value={draft.quietHours.start}
              disabled={!draft.quietHours.enabled}
              onChange={(e) => e.target.value && set('quietHours', { ...draft.quietHours, start: e.target.value })}
              aria-label="Quiet from"
            />
            <span>to</span>
            <input
              className={clsx(styles.textInput, styles.time)}
              type="time"
              value={draft.quietHours.end}
              disabled={!draft.quietHours.enabled}
              onChange={(e) => e.target.value && set('quietHours', { ...draft.quietHours, end: e.target.value })}
              aria-label="Quiet until"
            />
          </div>
        </div>
        <label className={styles.inline}>
          <span>At most</span>
          <select className={clsx(sectionStyles.select, styles.count)} value={draft.maxPerDay} onChange={(e) => set('maxPerDay', Number(e.target.value))} aria-label="Proactive conversations a day">
            {Array.from({ length: 11 }, (_, n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span>proactive conversations a day (scheduled and alerts together)</span>
        </label>
      </SettingsSection>

      {dirty && (
        <div className={styles.saveBar} role="region" aria-label="Unsaved changes">
          <span>{editing === 'organization' ? 'Unsaved changes to the company default' : 'Unsaved changes'}</span>
          <div className={styles.saveActions}>
            <Button variant="ghost" size="sm" onClick={() => setDraft(baseline)} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" onClick={() => void save()} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
