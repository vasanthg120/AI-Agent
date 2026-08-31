import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { Button } from '@/components/ui';
import shared from '../adminShared.module.css';

export function AdminPagination({ page, limit, total, onChange }: { page: number; limit: number; total: number; onChange: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (total === 0) return null;

  const start = (page - 1) * limit + 1;
  const end = Math.min(total, page * limit);

  return (
    <div className={shared.pageBar}>
      <span className={shared.pageBarInfo}>
        {start}–{end} of {total.toLocaleString()}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} leftIcon={<FiChevronLeft size={14} />}>
          Prev
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)} rightIcon={<FiChevronRight size={14} />}>
          Next
        </Button>
      </div>
    </div>
  );
}
