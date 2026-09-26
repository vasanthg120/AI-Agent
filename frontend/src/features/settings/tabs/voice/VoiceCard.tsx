import { FiAlertCircle, FiCheck } from 'react-icons/fi';
import clsx from 'clsx';
import { Badge, Button } from '@/components/ui';
import type { VoiceOption } from '@/services/voiceConfigService';
import { PreviewButton } from './PreviewButton';
import type { PreviewState } from './useVoicePreview';
import { ACCENT_CODE, GENDER_LABEL } from './voiceLabels';
import styles from './VoiceCard.module.css';

export interface VoiceCardProps {
  voice: VoiceOption;
  personalityName: string;
  // This voice is the one speaking for this person right now.
  inUse: boolean;
  previewState: PreviewState;
  onPreview: () => void;
  previewDisabledReason: string | null;
  onSelect: () => void;
  // Why choosing this voice is currently off (organization disallows it, a
  // save is in flight, ...) — null when it can be chosen.
  selectDisabledReason: string | null;
  saving: boolean;
  // Present only for owners/admins.
  onSetOrganizationDefault?: () => void;
  // False when the page already states this voice's unavailable reason once for
  // its whole group (every card in it shares one) — the card then shows just
  // an "Unavailable" badge instead of repeating the sentence.
  showUnavailableReason?: boolean;
}

export function VoiceCard({
  voice,
  personalityName,
  inUse,
  previewState,
  onPreview,
  previewDisabledReason,
  onSelect,
  selectDisabledReason,
  saving,
  onSetOrganizationDefault,
  showUnavailableReason = true,
}: VoiceCardProps) {
  const unavailable = !voice.isActive;
  return (
    <article
      className={clsx(
        styles.card,
        voice.isSelected && styles.selected,
        inUse && styles.inUse,
        unavailable && styles.unavailable,
      )}
      aria-label={voice.displayName}
    >
      <div className={styles.top}>
        <span className={styles.monogram} aria-hidden>
          {ACCENT_CODE[voice.accent]}
        </span>
        <div className={styles.titleBlock}>
          <h4 className={styles.name}>{voice.displayName}</h4>
          <span className={styles.meta}>
            {voice.accentLabel} · {GENDER_LABEL[voice.gender]}
          </span>
        </div>
      </div>

      <p className={styles.description}>{voice.description}</p>

      <div className={styles.tags}>
        <Badge>{personalityName}</Badge>
        {unavailable && <Badge variant="warning">Unavailable</Badge>}
        {inUse && (
          <Badge variant="success" dot>
            In use
          </Badge>
        )}
        {voice.isSelected && <Badge variant="accent">Your selection</Badge>}
        {voice.isDefault && <Badge variant="info">Organization default</Badge>}
      </div>

      {unavailable && showUnavailableReason && (
        <p className={styles.unavailableNote} role="status">
          <FiAlertCircle aria-hidden /> {voice.unavailableReason ?? 'Unavailable right now.'}
        </p>
      )}

      <div className={styles.actions}>
        <PreviewButton
          state={previewState}
          voiceName={voice.displayName}
          onClick={onPreview}
          disabled={previewDisabledReason !== null}
          title={previewDisabledReason ?? undefined}
        />
        {/* Selected / saving use aria-disabled rather than disabled, so keyboard
            focus stays on the button after it is activated. */}
        <Button
          type="button"
          size="sm"
          variant={voice.isSelected ? 'secondary' : 'primary'}
          leftIcon={voice.isSelected ? <FiCheck /> : undefined}
          className={clsx((voice.isSelected || saving) && styles.inert)}
          onClick={voice.isSelected || saving ? undefined : onSelect}
          disabled={selectDisabledReason !== null && !voice.isSelected}
          aria-disabled={voice.isSelected || saving || undefined}
          aria-busy={saving || undefined}
          title={selectDisabledReason ?? undefined}
          aria-label={voice.isSelected ? `${voice.displayName} is your selection` : `Use ${voice.displayName}`}
        >
          {saving ? 'Saving…' : voice.isSelected ? 'Selected' : 'Use this voice'}
        </Button>
      </div>

      {/* The current default already carries the "Organization default" badge. */}
      {onSetOrganizationDefault && !voice.isDefault && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={styles.orgAction}
          onClick={onSetOrganizationDefault}
          disabled={unavailable}
          title={unavailable ? 'This voice is unavailable right now.' : undefined}
        >
          Set as organization default
        </Button>
      )}
    </article>
  );
}
