import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiBell,
  FiBriefcase,
  FiCalendar,
  FiCheck,
  FiChevronRight,
  FiClock,
  FiCode,
  FiGlobe,
  FiLock,
  FiLogOut,
  FiMail,
  FiMapPin,
  FiPhone,
  FiRotateCcw,
  FiShield,
  FiUser,
  FiVolume2,
} from 'react-icons/fi';
import { Avatar, Button, Input, PageHeader } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { authService } from '@/services/authService';
import { organizationsService } from '@/services/organizationsService';
import { ROUTES } from '@/constants/routes';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { DEVICE_TIMEZONE, TIMEZONE_GROUPS, timeIn } from '@/utils/timezones';
import type { User } from '@/types';
import { SettingsSection, SettingsField } from '@/features/settings/components/SettingsSection';
import sectionStyles from '@/features/settings/components/SettingsSection.module.css';
import styles from './ProfilePage.module.css';

// Must match the backend's PROFILE_LANGUAGES (users/dto/update-profile.dto.ts).
const LANGUAGES: { value: string; label: string }[] = [
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'ta-IN', label: 'Tamil' },
  { value: 'te-IN', label: 'Telugu' },
  { value: 'kn-IN', label: 'Kannada' },
  { value: 'ml-IN', label: 'Malayalam' },
];

const PHONE_PATTERN = /^\+?[0-9 ()-]{5,}$/;
function roleLabel(role: string): string {
  return role.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

interface Draft {
  firstName: string;
  lastName: string;
  phone: string;
  timezone: string;
  language: string;
}

function draftFrom(user: User): Draft {
  return {
    firstName: user.firstName === user.email ? '' : user.firstName,
    lastName: user.lastName,
    phone: user.phone ?? '',
    timezone: user.timezone ?? DEVICE_TIMEZONE,
    language: user.language ?? 'en-US',
  };
}

export function ProfilePage() {
  const storeUser = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date());

  // The persisted auth-store user can be stale (it's only refreshed at
  // login), so the page always re-reads its own profile and writes the
  // fresh copy back into the store.
  const { data: freshUser } = useQuery({ queryKey: ['me'], queryFn: () => authService.getMe() });
  const { data: org } = useQuery({ queryKey: ['organization-me'], queryFn: () => organizationsService.getMine(), retry: false });

  const [baseline, setBaseline] = useState<User | null>(storeUser);
  const [draft, setDraft] = useState<Draft | null>(storeUser ? draftFrom(storeUser) : null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!freshUser) return;
    useAuthStore.setState((s) => ({ user: s.user ? { ...s.user, ...freshUser } : freshUser }));
    setBaseline(freshUser);
    setDraft((prev) => {
      // Don't clobber edits the user already started typing.
      const base = baseline ? draftFrom(baseline) : null;
      return prev && base && JSON.stringify(prev) !== JSON.stringify(base) ? prev : draftFrom(freshUser);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshUser]);

  // Local-time clock in the hero and timezone picker.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const initial = useMemo(() => (baseline ? draftFrom(baseline) : null), [baseline]);
  const dirty = !!draft && !!initial && JSON.stringify(draft) !== JSON.stringify(initial);
  const phoneError =
    draft && draft.phone.trim() && !PHONE_PATTERN.test(draft.phone.trim()) ? 'Use digits, spaces, ( ) - and an optional leading +' : null;
  const nameError = draft && !draft.firstName.trim() ? 'First name is required' : null;
  const canSave = dirty && !phoneError && !nameError && !saving;

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleSave = async () => {
    if (!draft || !initial || !canSave) return;
    setSaving(true);
    try {
      const patch: Record<string, string> = {};
      const name = `${draft.firstName.trim()} ${draft.lastName.trim()}`.trim();
      if (draft.firstName !== initial.firstName || draft.lastName !== initial.lastName) patch.name = name;
      if (draft.phone !== initial.phone) patch.phone = draft.phone.trim();
      if (draft.timezone !== initial.timezone) patch.timezone = draft.timezone;
      if (draft.language !== initial.language) patch.language = draft.language;
      const saved = await authService.updateMe(patch);
      useAuthStore.setState((s) => ({ user: s.user ? { ...s.user, ...saved } : saved }));
      setBaseline(saved);
      setDraft(draftFrom(saved));
      toast.success('Profile saved');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd+S saves, like a document.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  if (!baseline || !draft) return null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const displayName = `${draft.firstName || baseline.email} ${draft.lastName}`.trim();

  // What makes a profile "complete" — each one is something the user can fix here.
  const checks = [
    { label: 'First name', done: !!draft.firstName.trim() },
    { label: 'Last name', done: !!draft.lastName.trim() },
    { label: 'Phone number', done: !!draft.phone.trim() && !phoneError },
    { label: 'Time zone', done: !!baseline.timezone && baseline.timezone === draft.timezone },
    { label: 'Language', done: !!draft.language },
  ];
  const completePct = Math.round((checks.filter((c) => c.done).length / checks.length) * 100);
  const ringC = 2 * Math.PI * 22;

  const shortcuts = [
    { icon: FiShield, title: 'Security', text: 'Password, two-factor and active sessions', to: ROUTES.settingsSecurity },
    { icon: FiBell, title: 'Notifications', text: 'Push and email alerts', to: ROUTES.settingsNotifications },
    { icon: FiVolume2, title: 'Voice & Accent', text: 'How the AI sounds when it speaks', to: ROUTES.settingsVoice },
    { icon: FiCode, title: 'API tokens', text: 'Keys for connecting other tools', to: ROUTES.settingsSecurity },
  ];

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiUser}
        title="My Profile"
        subtitle="Your personal details and preferences. Changes are saved to your account and follow you to every device."
      />

      <motion.section
        className={styles.hero}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className={styles.heroBanner} aria-hidden />
        <div className={styles.heroBody}>
          <div className={styles.avatarRing}>
            <Avatar name={displayName} size="xl" />
          </div>
          <div className={styles.heroText}>
            <h2 className={styles.name}>{displayName}</h2>
            <span className={styles.email}>
              <FiMail /> {baseline.email}
            </span>
            <div className={styles.chips}>
              {baseline.roles.map((r) => (
                <span key={r} className={clsx(styles.chip, styles.chipRole)}>
                  <FiShield /> {roleLabel(r)}
                </span>
              ))}
              {org?.name && (
                <span className={styles.chip}>
                  <FiBriefcase /> {org.name}
                </span>
              )}
              {baseline.department && (
                <span className={styles.chip}>
                  <FiMapPin /> {baseline.department}
                </span>
              )}
              <span className={styles.chip}>
                <FiCalendar /> Member since {dayjs(baseline.createdAt).format('MMM YYYY')}
              </span>
              <span className={styles.chip}>
                <FiClock /> {timeIn(draft.timezone, now)} your time
              </span>
            </div>
          </div>

          <div className={styles.completeness} title={checks.filter((c) => !c.done).map((c) => `Missing: ${c.label}`).join('\n') || 'Complete'}>
            <svg viewBox="0 0 56 56" className={styles.ring} aria-hidden>
              <circle cx="28" cy="28" r="22" className={styles.ringTrack} />
              <motion.circle
                cx="28"
                cy="28"
                r="22"
                className={styles.ringFill}
                strokeDasharray={ringC}
                initial={{ strokeDashoffset: ringC }}
                animate={{ strokeDashoffset: ringC * (1 - completePct / 100) }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              />
            </svg>
            <span className={styles.ringValue}>{completePct}%</span>
            <span className={styles.ringLabel}>{completePct === 100 ? 'Profile complete' : 'Profile completeness'}</span>
          </div>
        </div>

        {completePct < 100 && (
          <div className={styles.todo}>
            <span className={styles.todoLabel}>To finish your profile:</span>
            {checks
              .filter((c) => !c.done)
              .map((c) => (
                <span key={c.label} className={styles.todoItem}>
                  {c.label}
                </span>
              ))}
          </div>
        )}
      </motion.section>

      <div className={styles.layout}>
        <div className={styles.main}>
          <SettingsSection icon={<FiUser />} title="Personal information" description="How your name appears to your team and in AI-written emails.">
            <div className={styles.grid2}>
              <Input
                label="First name"
                value={draft.firstName}
                onChange={(e) => set('firstName', e.target.value)}
                error={nameError ?? undefined}
                autoComplete="given-name"
              />
              <Input label="Last name" value={draft.lastName} onChange={(e) => set('lastName', e.target.value)} autoComplete="family-name" />
            </div>
            <div className={styles.grid2}>
              <Input
                label="Email"
                value={baseline.email}
                disabled
                leftIcon={<FiLock />}
                hint="Your sign-in email — only an admin can change it."
              />
              <Input
                label="Phone"
                type="tel"
                value={draft.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="+91 98765 43210"
                leftIcon={<FiPhone />}
                error={phoneError ?? undefined}
                autoComplete="tel"
              />
            </div>
          </SettingsSection>

          <SettingsSection icon={<FiGlobe />} title="Preferences" description="Your time zone and language.">
            <SettingsField label="Time zone">
              <select className={sectionStyles.select} value={draft.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {/* Keep the saved value selectable even if this browser names it differently. */}
                {!TIMEZONE_GROUPS.some(([, zones]) => zones.includes(draft.timezone)) && (
                  <option value={draft.timezone}>{draft.timezone}</option>
                )}
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
            <div className={styles.tzRow}>
              <span className={styles.tzNow}>
                <FiClock /> It's <strong>{timeIn(draft.timezone, now)}</strong> in {draft.timezone.replace(/_/g, ' ')}
              </span>
              {draft.timezone !== DEVICE_TIMEZONE && (
                <button type="button" className={styles.linkButton} onClick={() => set('timezone', DEVICE_TIMEZONE)}>
                  Use this device's time zone ({DEVICE_TIMEZONE.replace(/_/g, ' ')})
                </button>
              )}
            </div>
            <SettingsField label="Language">
              <select className={sectionStyles.select} value={draft.language} onChange={(e) => set('language', e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </SettingsField>
          </SettingsSection>
        </div>

        <aside className={styles.side}>
          <div className={styles.sideCard}>
            <div className={styles.sideTitle}>Account shortcuts</div>
            {shortcuts.map((s, i) => (
              <motion.button
                key={s.title}
                type="button"
                className={styles.shortcut}
                onClick={() => navigate(s.to)}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: 0.15 + i * 0.05 }}
              >
                <span className={styles.shortcutIcon}>
                  <s.icon />
                </span>
                <span className={styles.shortcutText}>
                  <span className={styles.shortcutTitle}>{s.title}</span>
                  <span className={styles.shortcutSub}>{s.text}</span>
                </span>
                <FiChevronRight className={styles.shortcutChevron} />
              </motion.button>
            ))}
          </div>

          <button
            type="button"
            className={styles.signOut}
            onClick={() => {
              void logout();
              navigate(ROUTES.login);
            }}
          >
            <FiLogOut /> Sign out
          </button>
        </aside>
      </div>

      <AnimatePresence>
        {dirty && (
          <motion.div
            className={styles.saveBar}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <span className={styles.saveBarText}>
              <span className={styles.saveBarDot} />
              You have unsaved changes
              <kbd className={styles.kbd}>Ctrl S</kbd>
            </span>
            <div className={styles.saveBarActions}>
              <Button type="button" variant="ghost" size="sm" leftIcon={<FiRotateCcw />} disabled={saving} onClick={() => setDraft(initial)}>
                Discard
              </Button>
              <Button type="button" size="sm" leftIcon={<FiCheck />} loading={saving} disabled={!canSave} onClick={() => void handleSave()}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
