import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiSun, FiZap } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { storeSettingsService } from '@/services/storeSettingsService';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin } from '@/utils/roles';
import styles from './GenerateReportEmptyState.module.css';

export interface GenerateReportEmptyStateProps {
  reportType: 'morning' | 'eod';
  title: string;
  description: string;
  onGenerated: () => void;
  // Defaults to true. Pass false when viewing a past date (e.g. the EOD
  // page's Calendar view) — "Generate Now" can't retroactively backfill a
  // day that's already gone, so the button must never appear there
  // regardless of role.
  showAction?: boolean;
}

// Shown when today's morning-to-do/EOD report hasn't been generated yet —
// it normally runs automatically near the store's opening/closing time (see
// backend/src/store-settings/store-settings.service.ts's checkAndRunDailyJobs),
// so logging in before that window (or on a day it hasn't fired yet) used to
// mean an empty, unexplained board with no way to do anything about it. The
// "Generate Now" trigger already existed on the backend (POST
// /store-settings/run-now) — this is the first UI ever wired to it, gated
// on the exact same role restriction the backend itself enforces
// (StoreSettingsController's own @Roles('admin')), so the button never
// appears somewhere it would just 403.
export function GenerateReportEmptyState({ reportType, title, description, onGenerated, showAction = true }: GenerateReportEmptyStateProps) {
  const user = useAuthStore((state) => state.user);
  const canGenerate = showAction && isAdmin(user);
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await storeSettingsService.runNow(reportType);
      if (result.usersNotified > 0) {
        toast.success(`Generated — ${result.usersNotified} of ${result.totalUsers} team member(s) notified.`);
      } else {
        toast.error('Nothing was generated — check that your store has team members and try again.');
      }
      onGenerated();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className={styles.wrapper}>
      <span className={styles.iconBadge}>
        <FiSun size={22} />
      </span>
      <div className={styles.title}>{title}</div>
      <p className={styles.body}>{description}</p>
      {canGenerate && (
        <Button leftIcon={<FiZap />} loading={generating} onClick={() => void handleGenerate()}>
          Generate Now
        </Button>
      )}
    </div>
  );
}
