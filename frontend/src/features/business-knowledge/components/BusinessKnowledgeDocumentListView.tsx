import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { FiArrowLeft, FiChevronRight, FiFile, FiFileText, FiGrid, FiImage } from 'react-icons/fi';
import { Badge, Button, EmptyState, Skeleton } from '@/components/ui';
import {
  businessKnowledgeDocumentsService,
  type BusinessKnowledgeDocument,
  type BusinessKnowledgeDocumentFilters,
} from '@/services/businessKnowledgeDocumentsService';
import styles from '../business-knowledge.module.css';

const PAGE_SIZE = 25;

function fileIcon(filename: string) {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return FiImage;
  if (['xlsx', 'xls', 'csv'].includes(ext)) return FiGrid;
  if (['pdf', 'docx', 'txt', 'md', 'html', 'htm'].includes(ext)) return FiFileText;
  return FiFile;
}

// Drill-down detail view, state-swap style — mirrors
// finance/components/FinanceDocumentListView.tsx exactly. Browsing many
// records is a separate job from reviewing one, which stays a Modal
// (BusinessKnowledgeDocumentReviewModal.tsx); each row here opens that modal.
export function BusinessKnowledgeDocumentListView({
  filters,
  onBack,
  onSelectDocument,
}: {
  filters: BusinessKnowledgeDocumentFilters;
  onBack: () => void;
  onSelectDocument: (doc: BusinessKnowledgeDocument) => void;
}) {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['business-knowledge-document-list', filters, page],
    queryFn: () => businessKnowledgeDocumentsService.listFiltered(filters, page, PAGE_SIZE),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className={styles.formGrid}>
      <div className={styles.listHeader}>
        <Button type="button" variant="ghost" size="sm" leftIcon={<FiArrowLeft />} onClick={onBack}>
          Back
        </Button>
        <div>
          <div className={styles.listTitle}>All documents</div>
          <div className={styles.listCount}>{data ? `${data.total} document${data.total === 1 ? '' : 's'}` : 'Loading…'}</div>
        </div>
      </div>

      {isLoading || !data ? (
        <div className={styles.formGrid}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={62} />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <EmptyState icon={FiFileText} title="No documents yet" description="Upload a catalog, price list or manual above and it will show up here." />
      ) : (
        <>
          <div className={styles.docList}>
            {data.items.map((d, i) => {
              const Icon = fileIcon(d.originalFilename);
              return (
                <motion.button
                  key={d._id}
                  type="button"
                  className={styles.docRow}
                  onClick={() => onSelectDocument(d)}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: Math.min(i, 10) * 0.025 }}
                >
                  <span className={styles.docIcon}>
                    <Icon />
                  </span>
                  <span className={styles.docText}>
                    <span className={styles.docTitle}>{d.title ?? d.originalFilename}</span>
                    <span className={styles.docMeta}>
                      {d.assetType.replace(/_/g, ' ')} · {new Date(d.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <Badge variant={d.reviewStatus === 'reviewed' ? 'success' : 'warning'}>
                    {d.reviewStatus === 'reviewed' ? 'Reviewed' : 'Needs review'}
                  </Badge>
                  <FiChevronRight className={styles.docChevron} />
                </motion.button>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className={styles.headerActions}>
              <Button type="button" variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className={styles.pageSubtitle}>
                Page {page} of {totalPages}
              </span>
              <Button type="button" variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
