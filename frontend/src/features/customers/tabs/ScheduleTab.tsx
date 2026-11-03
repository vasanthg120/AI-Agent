import { memo } from 'react';
import type { ReactNode } from 'react';
import { FiCalendar } from 'react-icons/fi';
import { EmptyState, PageHeader } from '@/components/ui';
import customerStyles from '../customers.module.css';

// Hoops-parity — no production calendar/scheduling backend exists in HaiVE
// yet. This is a clean integration boundary, not a fabricated calendar
// with invented events.
export const ScheduleTab = memo(function ScheduleTab({ tabs, offstage }: { tabs: ReactNode; offstage: boolean }) {
  return (
    <div className={customerStyles.page} hidden={offstage}>
      {tabs}
      <PageHeader icon={FiCalendar} title="Schedule" subtitle="Your team's production calendar." />
      <EmptyState
        icon={FiCalendar}
        title="Not connected yet"
        description="HaiVE doesn't have a production schedule/calendar backend yet. This page is a placeholder, not a working calendar — building one is a separate, larger piece of work."
      />
    </div>
  );
});
