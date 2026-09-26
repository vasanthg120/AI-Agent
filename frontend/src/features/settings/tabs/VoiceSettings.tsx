import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { FiAlertCircle, FiSearch } from 'react-icons/fi';
import { Button, Card, Input, Skeleton } from '@/components/ui';
import {
  VOICE_ACCENT_ORDER,
  voiceConfigService,
  type OrganizationVoicePatch,
  type VoiceAccent,
  type VoiceConfig,
  type VoiceGender,
  type VoiceOption,
  type VoicePersonality,
} from '@/services/voiceConfigService';
import { extractErrorMessage } from '@/utils/errors';
import { ActiveVoiceSummary } from './voice/ActiveVoiceSummary';
import { ChipRadioGroup } from './voice/ChipRadioGroup';
import { OrganizationVoiceCard } from './voice/OrganizationVoiceCard';
import { useVoicePreview } from './voice/useVoicePreview';
import { VoiceCard } from './voice/VoiceCard';
import { GENDER_LABEL, matchesQuery, personalityLabel } from './voice/voiceLabels';
import styles from './VoiceSettings.module.css';

// When every voice in a group is unavailable for the same reason (the usual case:
// its provider isn't connected), the page says so once under the group's title
// instead of repeating the sentence on each card.
function sharedUnavailableReason(voices: VoiceOption[]): string | null {
  if (voices.length < 2 || voices.some((v) => v.isActive)) return null;
  const reasons = new Set(voices.map((v) => v.unavailableReason ?? 'Unavailable right now.'));
  return reasons.size === 1 ? [...reasons][0] : null;
}

// Values shown immediately while their save is still in flight, so a chip or
// switch responds to the click (and keyboard focus stays put) instead of
// snapping back until the server answers. Cleared once every queued save has
// finished — on success the server's own values take over, on failure the
// control returns to what is actually saved.
interface PendingValues {
  style?: VoicePersonality | null;
  orgStyle?: VoicePersonality | null;
  allowOverride?: boolean;
}

// Voice & Accent — how the AI Call Copilot (and every other feature that
// speaks) sounds. One configuration for all speech: the backend applies it
// wherever audio is produced, so nothing here is per-feature.
export function VoiceSettings() {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which save is running ('voice:<id>' | 'personality' | 'org' | 'reset').
  // Saves are queued and run one after another, never dropped and never
  // concurrent, so the last change always wins and the page can't show two
  // half-applied ones — while the controls stay enabled, so keyboard focus
  // survives an arrow-key change.
  const [saving, setSaving] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingValues>({});
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightRef = useRef(0);

  const [query, setQuery] = useState('');
  const [accent, setAccent] = useState<'all' | VoiceAccent>('all');
  const [gender, setGender] = useState<'all' | VoiceGender>('all');

  const preview = useVoicePreview();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setConfig(await voiceConfigService.getConfig());
    } catch (err) {
      setLoadError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // What the controls display: the saved configuration with any in-flight
  // change applied on top.
  const view = useMemo<VoiceConfig | null>(
    () =>
      config && {
        ...config,
        user: {
          ...config.user,
          personality: pending.style !== undefined ? pending.style : config.user.personality,
        },
        organization: {
          ...config.organization,
          defaultPersonality:
            pending.orgStyle !== undefined ? pending.orgStyle : config.organization.defaultPersonality,
          allowUserOverride: pending.allowOverride ?? config.organization.allowUserOverride,
        },
      },
    [config, pending],
  );

  const save = (key: string, action: () => Promise<VoiceConfig>, message: string, optimistic?: PendingValues) => {
    if (optimistic) setPending((current) => ({ ...current, ...optimistic }));
    inFlightRef.current += 1;
    const run = async () => {
      setSaving(key);
      try {
        setConfig(await action());
        toast.success(message);
      } catch (err) {
        toast.error(extractErrorMessage(err));
      } finally {
        setSaving(null);
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0) setPending({});
      }
    };
    queueRef.current = queueRef.current.then(run);
    return queueRef.current;
  };

  const selectVoice = (voice: VoiceOption) =>
    save(
      `voice:${voice.voiceId}`,
      () => voiceConfigService.updateMine({ voiceId: voice.voiceId }),
      `Now using ${voice.displayName}`,
    );

  const changePersonality = (personality: VoicePersonality | null) => {
    if (personality === (view?.user.personality ?? null)) return;
    return save('personality', () => voiceConfigService.updateMine({ personality }), 'Speaking style updated', {
      style: personality,
    });
  };

  const resetMine = () =>
    save(
      'reset',
      () => voiceConfigService.updateMine({ voiceId: null, personality: null }),
      'Back to the default voice',
    );

  const updateOrganization = (patch: OrganizationVoicePatch, message = 'Organization defaults updated') =>
    save('org', () => voiceConfigService.updateOrganization(patch), message, {
      ...(patch.defaultPersonality !== undefined && {
        orgStyle: patch.defaultPersonality,
      }),
      ...(patch.allowUserOverride !== undefined && {
        allowOverride: patch.allowUserOverride,
      }),
    });

  const visibleGroups = useMemo(() => {
    if (!config) return [];
    return VOICE_ACCENT_ORDER.map((groupAccent) => ({
      accent: groupAccent,
      voices: config.voices.filter(
        (v) =>
          v.accent === groupAccent &&
          (accent === 'all' || v.accent === accent) &&
          (gender === 'all' || v.gender === gender) &&
          matchesQuery(v, query),
      ),
    })).filter((group) => group.voices.length > 0);
  }, [config, accent, gender, query]);

  if (loading) {
    return (
      <div className={styles.page} aria-busy="true">
        <Card>
          <Skeleton height={56} />
          <Skeleton height={40} />
          <Skeleton height={32} />
        </Card>
        <div className={styles.grid}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={210} />
          ))}
        </div>
      </div>
    );
  }

  if (loadError || !config || !view) {
    return (
      <Card className={styles.errorCard} role="alert">
        <h2 className={styles.errorTitle}>Voice & Accent couldn't be loaded</h2>
        <p className={styles.errorText}>{loadError ?? 'Something went wrong.'}</p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  const previewPersonality = view.user.personality;
  const groupTotal = visibleGroups.reduce((sum, group) => sum + group.voices.length, 0);
  const filtersActive = query.trim() !== '' || accent !== 'all' || gender !== 'all';

  const accentOptions = [
    { value: 'all', label: 'All accents' },
    ...VOICE_ACCENT_ORDER.map((a) => ({
      value: a,
      label: config.voices.find((v) => v.accent === a)?.accentLabel ?? a,
    })),
  ];
  const genderOptions = [
    { value: 'all', label: 'Any voice' },
    { value: 'female', label: GENDER_LABEL.female },
    { value: 'male', label: GENDER_LABEL.male },
  ];

  const previewDisabledReason = (voice: VoiceOption): string | null =>
    !config.voiceAccessEnabled
      ? 'Voice is turned off for your account.'
      : voice.isActive
        ? null
        : voice.unavailableReason;

  const activeVoice = config.voices.find((v) => v.voiceId === config.active.voiceId);

  return (
    <div className={styles.page}>
      <ActiveVoiceSummary
        config={view}
        previewState={activeVoice ? preview.stateOf(activeVoice.voiceId) : 'idle'}
        onPreview={() => activeVoice && void preview.toggle(activeVoice.voiceId, previewPersonality)}
        onPersonalityChange={(p) => void changePersonality(p)}
        onReset={() => void resetMine()}
        saving={saving}
      />

      {config.canConfigureOrganization && (
        <OrganizationVoiceCard config={view} saving={saving} onChange={(patch) => void updateOrganization(patch)} />
      )}

      <section className={styles.browser} aria-labelledby="voice-browser-title">
        <div className={styles.browserHeader}>
          <div>
            <h2 id="voice-browser-title" className={styles.sectionTitle}>
              Voices
            </h2>
            <p className={styles.sectionHint}>Preview a voice, then choose the one you want to hear.</p>
          </div>
          <span className={styles.count} aria-live="polite">
            {groupTotal} of {config.voices.length}
          </span>
        </div>

        <div className={styles.filters}>
          <div className={styles.search}>
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search voices"
              aria-label="Search voices"
              leftIcon={<FiSearch />}
            />
          </div>
          <ChipRadioGroup
            label="Filter by accent"
            options={accentOptions}
            value={accent}
            onChange={(value) => setAccent(value as 'all' | VoiceAccent)}
            small
          />
          <ChipRadioGroup
            label="Filter by voice"
            options={genderOptions}
            value={gender}
            onChange={(value) => setGender(value as 'all' | VoiceGender)}
            small
          />
        </div>

        {visibleGroups.length === 0 ? (
          <Card className={styles.empty}>
            <p className={styles.emptyTitle}>No voices match</p>
            <p className={styles.emptyText}>Try a different search, or clear the filters to see every voice.</p>
            {filtersActive && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setAccent('all');
                  setGender('all');
                }}
              >
                Clear filters
              </Button>
            )}
          </Card>
        ) : (
          visibleGroups.map((group) => {
            const sharedReason = sharedUnavailableReason(group.voices);
            return (
              <div key={group.accent} className={styles.group}>
                <h3 className={styles.groupTitle}>
                  {group.voices[0].accentLabel}
                  <span className={styles.groupCount}>{group.voices.length}</span>
                </h3>
                {sharedReason && (
                  <p className={styles.groupNotice} role="status">
                    <FiAlertCircle aria-hidden /> {sharedReason}
                  </p>
                )}
                <div className={styles.grid}>
                  {group.voices.map((voice) => (
                    <VoiceCard
                      key={voice.voiceId}
                      voice={voice}
                      personalityName={personalityLabel(config, voice.personality)}
                      inUse={voice.voiceId === config.active.voiceId}
                      previewState={preview.stateOf(voice.voiceId)}
                      onPreview={() => void preview.toggle(voice.voiceId, previewPersonality)}
                      previewDisabledReason={previewDisabledReason(voice)}
                      onSelect={() => void selectVoice(voice)}
                      selectDisabledReason={
                        !config.canChooseOwnVoice
                          ? 'Your organization sets the voice for everyone.'
                          : !voice.isActive
                            ? (voice.unavailableReason ?? 'Unavailable right now.')
                            : null
                      }
                      saving={saving === `voice:${voice.voiceId}`}
                      showUnavailableReason={sharedReason === null}
                      onSetOrganizationDefault={
                        config.canConfigureOrganization
                          ? () =>
                              void updateOrganization(
                                { defaultVoiceId: voice.voiceId },
                                `${voice.displayName} is now the organization default`,
                              )
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
