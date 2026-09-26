import { useState } from 'react';
import { FiArrowRight, FiBook, FiDollarSign, FiFileText, FiImage, FiLayers, FiUploadCloud } from 'react-icons/fi';
import { Button, SectionCard } from '@/components/ui';
import type { BusinessKnowledgeDocument } from '@/services/businessKnowledgeDocumentsService';
import { BusinessKnowledgeDocumentUpload } from './BusinessKnowledgeDocumentUpload';
import { BusinessKnowledgeDocumentListView } from './BusinessKnowledgeDocumentListView';
import { BusinessKnowledgeDocumentReviewModal } from './BusinessKnowledgeDocumentReviewModal';
import styles from '../business-knowledge.module.css';

// Encapsulates the whole Documents tab — upload widget always visible, plus
// a state-swap into the full document list (same pattern
// DealPerformancePage.tsx's drill-down uses), with the review modal
// reachable from a list row. canEdit gates upload/delete/edit only; every
// role that can reach this page can browse and open a document to view its
// AI summary (see Phase 14a plan notes' RBAC split).
const DOC_TYPES = [
  { icon: FiBook, label: 'Product catalogs' },
  { icon: FiDollarSign, label: 'Price lists' },
  { icon: FiLayers, label: 'Sales decks' },
  { icon: FiImage, label: 'Brochures & brand guides' },
  { icon: FiFileText, label: 'Agreements & manuals' },
];

export function BusinessKnowledgeDocumentsSection({ canEdit }: { canEdit: boolean }) {
  const [browsing, setBrowsing] = useState(false);
  const [reviewing, setReviewing] = useState<BusinessKnowledgeDocument | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className={styles.tabContent}>
      {canEdit && (
        <SectionCard title="Upload Business Documents" icon={FiUploadCloud}>
          <BusinessKnowledgeDocumentUpload onDocumentReady={() => setRefreshKey((k) => k + 1)} />
        </SectionCard>
      )}

      {browsing ? (
        <BusinessKnowledgeDocumentListView
          key={refreshKey}
          filters={{}}
          onBack={() => setBrowsing(false)}
          onSelectDocument={(doc) => setReviewing(doc)}
        />
      ) : (
        <SectionCard
          title="Documents & Assets"
          icon={FiFileText}
          action={
            <Button type="button" size="sm" rightIcon={<FiArrowRight />} onClick={() => setBrowsing(true)}>
              Browse all
            </Button>
          }
        >
          <p className={styles.explainer}>
            Everything you upload is read, summarized and classified by the AI — and becomes searchable by every AI
            assistant in your organization straight away.
          </p>
          <div className={styles.docTypes}>
            {DOC_TYPES.map(({ icon: Icon, label }) => (
              <span key={label} className={styles.docType}>
                <Icon /> {label}
              </span>
            ))}
          </div>
        </SectionCard>
      )}

      <BusinessKnowledgeDocumentReviewModal
        open={!!reviewing}
        document={reviewing}
        onClose={() => setReviewing(null)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        onDeleted={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}
