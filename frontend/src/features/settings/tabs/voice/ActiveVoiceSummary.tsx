import type { ReactNode } from 'react';
import { FiAlertCircle, FiInfo } from 'react-icons/fi';
import clsx from 'clsx';
import { Badge, Button, Card } from '@/components/ui';
import type { PersonalitySource, VoiceConfig, VoicePersonality } from '@/services/voiceConfigService';
import { ChipRadioGroup } from './ChipRadioGroup';
import { PreviewButton } from './PreviewButton';
import type { PreviewState } from './useVoicePreview';
import { ACCENT_CODE, GENDER_LABEL, SOURCE_LABEL, findVoice, personalityLabel } from './voiceLabels';
import styles from './ActiveVoiceSummary.module.css';

const PERSONALITY_SOURCE_TEXT: Record<PersonalitySource, string> = {
  user: 'your choice',
  organization: "your organization's default",
  voice: "this voice's own style",
};

function Notice({ tone, children }: { tone: 'warning' | 'info'; children: ReactNode }) {
  return (
    <div className={clsx(styles.notice, styles[tone])} role="status">
      {tone === 'warning' ? <FiAlertCircle aria-hidden /> : <FiInfo aria-hidden />}
      <div>{children}</div>
    </div>
  );
}

// The top of the page: what is speaking for this person right now, and why —
// keeping the three levels of the configuration (organization default, your
// selection, what is actually in use) visibly separate — plus the one optional
// setting that isn't a voice: speaking style.
export function ActiveVoiceSummary({
  config,
  previewState,
  onPreview,
  onPersonalityChange,
  onReset,
  saving,
}: {
  config: VoiceConfig;
  previewState: PreviewState;
  onPreview: () => void;
  onPersonalityChange: (personality: VoicePersonality | null) => void;
  onReset: () => void;
  saving: string | null;
}) {
  const { active, organization, user } = config;
  const activeVoice = findVoice(config, active.voiceId);
  const orgVoice = findVoice(config, organization.defaultVoiceId);
  const ownVoice = findVoice(config, user.voiceId);
  const systemVoice = findVoice(config, config.systemDefaultVoiceId);
  const hasOwnChoice = Boolean(user.voiceId || user.personality);

  const styleOptions = [
    { value: '', label: 'Default' },
    ...config.personalities.map((p) => ({
      value: p.id,
      label: p.label,
      title: p.hint,
    })),
  ];

  return (
    <Card className={styles.card}>
      <div className={styles.headline}>
        <span className={styles.monogram} aria-hidden>
          {activeVoice ? ACCENT_CODE[activeVoice.accent] : '—'}
        </span>
        <div className={styles.headlineText}>
          <span className={styles.eyebrow}>Currently speaking as</span>
          <h2 className={styles.voiceName}>{activeVoice?.displayName ?? 'Default voice'}</h2>
          <span className={styles.voiceMeta}>
            {activeVoice ? `${activeVoice.accentLabel} · ${GENDER_LABEL[activeVoice.gender]} · ` : ''}
            {personalityLabel(config, active.personality)}
          </span>
        </div>
        <div className={styles.headlineActions}>
          <Badge variant={active.source === 'user' ? 'accent' : active.source === 'organization' ? 'info' : 'neutral'}>
            {SOURCE_LABEL[active.source]}
          </Badge>
          {activeVoice && (
            <PreviewButton
              state={previewState}
              voiceName={activeVoice.displayName}
              onClick={onPreview}
              disabled={!config.voiceAccessEnabled}
              title={config.voiceAccessEnabled ? undefined : 'Voice access is turned off for your account.'}
            />
          )}
        </div>
      </div>

      <dl className={styles.levels}>
        <div className={styles.level}>
          <dt>Organization default</dt>
          <dd>
            {orgVoice ? orgVoice.displayName : `Not set — uses ${systemVoice?.displayName ?? 'the system default'}`}
          </dd>
        </div>
        <div className={styles.level}>
          <dt>Your selection</dt>
          <dd>
            {!config.canChooseOwnVoice
              ? 'Turned off by your organization'
              : ownVoice
                ? ownVoice.displayName
                : 'None — you use the default above'}
          </dd>
        </div>
      </dl>

      <div className={styles.style}>
        <div className={styles.styleHeader}>
          <span className={styles.styleLabel}>Speaking style</span>
          <span className={styles.styleHint}>
            Optional · currently {personalityLabel(config, active.personality)} (
            {PERSONALITY_SOURCE_TEXT[active.personalitySource]})
          </span>
        </div>
        <ChipRadioGroup
          label="Speaking style"
          options={styleOptions}
          value={config.canChooseOwnVoice ? (user.personality ?? '') : ''}
          onChange={(value) => onPersonalityChange(value === '' ? null : (value as VoicePersonality))}
          disabled={!config.canChooseOwnVoice}
        />
      </div>

      {active.fallback && (
        <Notice tone="warning">
          {active.fallback.requestedFrom === 'user' ? 'Your selected voice' : "Your organization's default voice"},{' '}
          <strong>{active.fallback.requestedDisplayName}</strong>, isn't available right now, so{' '}
          <strong>{activeVoice?.displayName ?? 'the default voice'}</strong> is being used instead.
          <span className={styles.noticeDetail}>{active.fallback.reason}</span>
        </Notice>
      )}
      {!config.availabilityChecked && (
        <Notice tone="info">
          Voice availability couldn't be checked just now, so every voice is shown as available. If one doesn't play,
          try again in a moment.
        </Notice>
      )}
      {!config.voiceAccessEnabled && (
        <Notice tone="warning">
          Voice is turned off for your account, so previews and spoken replies aren't available. Ask an administrator to
          enable it.
        </Notice>
      )}
      {!config.canChooseOwnVoice && (
        <Notice tone="info">Your organization sets one voice for everyone, so choosing your own is turned off.</Notice>
      )}

      {config.canChooseOwnVoice && hasOwnChoice && (
        <div className={styles.footer}>
          <Button type="button" variant="ghost" size="sm" onClick={onReset} loading={saving === 'reset'}>
            {orgVoice ? 'Use the organization default' : 'Use the system default'}
          </Button>
        </div>
      )}
    </Card>
  );
}
