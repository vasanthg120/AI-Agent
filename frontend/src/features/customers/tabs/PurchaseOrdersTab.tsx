import { memo } from 'react';
import type { ReactNode } from 'react';
import { FiShoppingBag } from 'react-icons/fi';
import { Button, EmptyState, PageHeader } from '@/components/ui';
import customerStyles from '../customers.module.css';

// Hoops-parity — Purchase orders already exist and work for real, but only
// per job (JobPanel's own "Purchase orders" tab, backed by
// customerJobsService), one job's list at a time. A flat, cross-job board
// needs a new backend aggregation across every job's embedded
// purchaseOrders array, which hasn't been built — this tab says so
// honestly and points at where purchase orders genuinely live today,
// rather than faking a board with no real rows behind it.
export const PurchaseOrdersTab = memo(function PurchaseOrdersTab({
  tabs,
  offstage,
  onGoToJobBoard,
}: {
  tabs: ReactNode;
  offstage: boolean;
  onGoToJobBoard: () => void;
}) {
  return (
    <div className={customerStyles.page} hidden={offstage}>
      {tabs}
      <PageHeader icon={FiShoppingBag} title="Purchase Orders" subtitle="What's been ordered for jobs in production." />
      <EmptyState
        icon={FiShoppingBag}
        title="Not yet a standalone board"
        description="Purchase orders are tracked per job today — open a job on the Job board and use its Purchase orders tab. A board across every job needs a backend change that hasn't been built yet."
        action={
          <Button type="button" onClick={onGoToJobBoard}>
            Go to Job board
          </Button>
        }
      />
    </div>
  );
});
