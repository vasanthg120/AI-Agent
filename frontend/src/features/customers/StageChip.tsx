import { FiChevronDown, FiEdit3 } from 'react-icons/fi';
import clsx from 'clsx';
import type { Stage } from '@/services/customersService';
import styles from './StageChip.module.css';

// What a chip needs: one of a customer's six steps is one, and so is one of a job's seven statuses.
export type ChipStage = Pick<Stage, 'title' | 'label' | 'tone'> &
  Partial<Pick<Stage, 'detail' | 'manual'>> & {
    // The status in full, where the chip itself carries a shorter form.
    full?: string;
  };

// What a chip says in full: its step, its status, and — when the team set it by hand — who did, and what the
// connected systems say instead.
export function stageSummary(stage: ChipStage): string {
  const said = [stage.title, stage.manual?.label ?? stage.full ?? stage.label].join(': ');
  if (!stage.manual) return [said, stage.detail].filter(Boolean).join(' · ');
  return `${said} · set by ${stage.manual.by ?? 'your team'} (the connected systems say: ${stage.manual.automatic})`;
}

// One step of the work with a customer: a coloured chip saying where it
// stands, and one line of what is behind it. The colour means the same on the
// board, on a card and in the panel: green = done, blue = moving, amber =
// needs attention soon, red = act now, grey = nothing to do or nothing there.
// A small pencil on its corner marks a status the team set by hand.
export function StageChip({
  stage,
  showTitle = false,
  showDetail = true,
  menu = false,
}: {
  stage: ChipStage;
  // The step's name above the chip — where there is no column heading to say it.
  showTitle?: boolean;
  showDetail?: boolean;
  // The chip opens a list of statuses to choose from.
  menu?: boolean;
}) {
  return (
    <div className={clsx(styles.stage, styles[stage.tone], menu && styles.asMenu)}>
      {showTitle && <span className={styles.title}>{stage.title}</span>}
      <span className={styles.chipWrap}>
        <span className={styles.chip} title={stageSummary(stage)}>
          <span className={styles.chipLabel}>{stage.label}</span>
          {menu && <FiChevronDown aria-hidden className={styles.chevron} />}
        </span>
        {/* On the corner, not in the chip: the words keep all the room there is. */}
        {stage.manual && (
          <span className={styles.byHand} role="img" aria-label="Set by hand" title="Set by hand">
            <FiEdit3 aria-hidden />
          </span>
        )}
      </span>
      {showDetail && stage.detail && (
        <span className={styles.detail} title={stage.detail}>
          {stage.detail}
        </span>
      )}
    </div>
  );
}
