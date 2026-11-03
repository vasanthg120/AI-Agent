import { memo } from 'react';
import type { ReactNode } from 'react';
import { FiBox } from 'react-icons/fi';
import { EmptyState, PageHeader } from '@/components/ui';
import customerStyles from '../customers.module.css';

// Hoops-parity — no stock/inventory concept exists anywhere in HaiVE yet
// (Product has no stockQuantity field, and this was an earlier, explicit
// project decision — see the Hoops Parity Plan doc's Phase 0 audit). This
// is a clean integration boundary, not a fabricated stock count.
export const StockTab = memo(function StockTab({ tabs, offstage }: { tabs: ReactNode; offstage: boolean }) {
  return (
    <div className={customerStyles.page} hidden={offstage}>
      {tabs}
      <PageHeader icon={FiBox} title="Stock" subtitle="On-hand quantity for what you sell." />
      <EmptyState
        icon={FiBox}
        title="Not connected yet"
        description="HaiVE doesn't track stock quantity yet — Catalog's Product records have no quantity field today. This page is a placeholder, not a working stock count."
      />
    </div>
  );
});
