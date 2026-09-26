import { FiPlay, FiSquare } from 'react-icons/fi';
import { Button, Spinner } from '@/components/ui';
import type { PreviewState } from './useVoicePreview';

// Play -> spinner while the sample is generated -> Stop while it plays. Stays
// clickable while loading so a slow sample can be cancelled.
export function PreviewButton({
  state,
  voiceName,
  onClick,
  disabled,
  title,
}: {
  state: PreviewState;
  voiceName: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const busy = state !== 'idle';
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={busy ? `Stop previewing ${voiceName}` : `Preview ${voiceName}`}
      leftIcon={state === 'loading' ? <Spinner size={14} /> : state === 'playing' ? <FiSquare /> : <FiPlay />}
    >
      {state === 'loading' ? 'Loading…' : state === 'playing' ? 'Stop' : 'Preview'}
    </Button>
  );
}
