import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { Button } from '@/components/ui';
import styles from './Pagination.module.css';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  itemLabel?: string;
  onPageChange: (page: number) => void;
}

// The one prev/next + range summary every *ListXResult (deals, quotes,
// products, ...) backend shape already returns — so this never needs to
// know anything beyond {page, pageSize, total}.
export function Pagination({ page, pageSize, total, itemLabel = 'items', onPageChange }: PaginationProps) {
  if (total <= pageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className={styles.pagination}>
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()} {itemLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        leftIcon={<FiChevronLeft />}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        rightIcon={<FiChevronRight />}
        disabled={page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}
