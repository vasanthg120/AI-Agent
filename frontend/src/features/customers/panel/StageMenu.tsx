import { FiCalendar, FiCheck, FiClock, FiMail, FiRefreshCw } from 'react-icons/fi';
import clsx from 'clsx';
import { Dropdown } from '@/components/ui';
import type { DropdownItem } from '@/components/ui';
import type { Stage, StageOption, StageTone } from '@/services/customersService';
import { StageChip, stageSummary } from '../StageChip';
import styles from './panel.module.css';

const Dot = ({ tone }: { tone: StageTone }) => (
  <span className={clsx(styles.optionDot, styles[`tone_${tone}`])} aria-hidden />
);
// The one in force carries a tick.
const ticked = (on: boolean, label: string) => (on ? `${label}  ✓` : label);

// What the Follow-up status can do besides being set: it is driven by real tasks and reminders,
// so most of its menu creates or finishes them.
export interface FollowUpActions {
  // Tasks of the team's own that are still open on this customer.
  openTasks: number;
  // Reminders set on their emails that are still to do (they are finished in AI Email Inbox).
  reminders: number;
  onSchedule: (daysFromToday: number) => void;
  onPickDate: () => void;
  onDone: () => void;
  onShowReminders: () => void;
}

// One of the six statuses at the top of the panel, as a menu: click it to set the status by hand, or to
// hand it back to what the connected systems say ("Automatic"). A status set by hand is saved in HaiVE only.
export function StageMenu({
  stage,
  options,
  align,
  busy,
  onSet,
  followUp,
}: {
  stage: Stage;
  options: StageOption[];
  align: 'left' | 'right';
  busy: boolean;
  // A status of this step, or null for "Automatic".
  onSet: (status: string | null) => void;
  followUp?: FollowUpActions;
}) {
  const byHand = !!stage.manual;
  const items: DropdownItem[] = [];

  if (followUp) {
    const waiting = followUp.openTasks + followUp.reminders;
    items.push(
      { id: 'today', label: 'Follow up today', icon: <FiClock />, onSelect: () => followUp.onSchedule(0) },
      { id: 'tomorrow', label: 'Follow up tomorrow', icon: <FiClock />, onSelect: () => followUp.onSchedule(1) },
      { id: 'three', label: 'Follow up in 3 days', icon: <FiClock />, onSelect: () => followUp.onSchedule(3) },
      { id: 'week', label: 'Follow up next week', icon: <FiClock />, onSelect: () => followUp.onSchedule(7) },
      { id: 'date', label: 'Pick another date…', icon: <FiCalendar />, onSelect: followUp.onPickDate },
    );
    if (followUp.openTasks > 0)
      items.push({
        id: 'done',
        label: followUp.openTasks === 1 ? 'Mark the follow-up done' : `Mark ${followUp.openTasks} follow-ups done`,
        icon: <FiCheck />,
        separatorBefore: true,
        onSelect: followUp.onDone,
      });
    if (followUp.reminders > 0)
      items.push({
        id: 'reminders',
        label: followUp.reminders === 1 ? 'See the email reminder' : `See ${followUp.reminders} email reminders`,
        icon: <FiMail />,
        separatorBefore: followUp.openTasks === 0,
        onSelect: followUp.onShowReminders,
      });
    // "Not needed" can only be said while nothing is waiting to be done.
    if (waiting === 0)
      for (const option of options)
        items.push({
          id: option.status,
          label: ticked(byHand && stage.status === option.status, option.label),
          icon: <Dot tone={option.tone} />,
          separatorBefore: true,
          onSelect: () => onSet(option.status),
        });
    if (byHand)
      items.push({
        id: 'automatic',
        label: 'Automatic — from follow-ups and email reminders',
        icon: <FiRefreshCw />,
        onSelect: () => onSet(null),
      });
  } else {
    // First: what the connected systems say, and the way back to it.
    items.push({
      id: 'automatic',
      label: ticked(!byHand, `Automatic — ${stage.manual?.automatic ?? stage.label}`),
      icon: <FiRefreshCw />,
      onSelect: () => onSet(null),
    });
    options.forEach((option, index) =>
      items.push({
        id: option.status,
        label: ticked(byHand && stage.status === option.status, option.label),
        icon: <Dot tone={option.tone} />,
        separatorBefore: index === 0,
        onSelect: () => onSet(option.status),
      }),
    );
  }

  return (
    <Dropdown
      className={styles.stageMenu}
      align={align}
      items={items}
      trigger={
        <button
          type="button"
          className={styles.stageButton}
          aria-haspopup="menu"
          aria-label={`${stageSummary(stage)}. Change the ${stage.title.toLowerCase()} status`}
          disabled={busy}
        >
          <StageChip stage={stage} showTitle showDetail={false} menu />
        </button>
      }
    />
  );
}
