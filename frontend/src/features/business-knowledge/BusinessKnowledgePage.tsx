import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { businessProfileService } from '@/services/businessProfileService';
import { BusinessProfileForm } from './components/BusinessProfileForm';
import { BusinessKnowledgeDocumentsSection } from './components/BusinessKnowledgeDocumentsSection';
import { BusinessKnowledgeOverviewSection } from './components/BusinessKnowledgeOverviewSection';
import { BusinessKnowledgeAdvisorSection } from './components/BusinessKnowledgeAdvisorSection';
import { BusinessKnowledgeRecommendationsSection } from './components/BusinessKnowledgeRecommendationsSection';
import { RelationshipsSection } from './components/RelationshipsSection';
import styles from './business-knowledge.module.css';

const TAB_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'profile', label: 'Business Profile' },
  { id: 'documents', label: 'Documents' },
  { id: 'advisor', label: 'AI Advisor' },
  { id: 'recommendations', label: 'Recommendations' },
  { id: 'relationships', label: 'Relationships' },
];
const TAB_IDS = TAB_ITEMS.map((t) => t.id);

export function BusinessKnowledgePage() {
  const user = useAuthStore((s) => s.user);
  const canEdit = hasRole(user, 'owner') || hasRole(user, 'admin');
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(initialTab && TAB_IDS.includes(initialTab) ? initialTab : 'overview');

  const changeTab = (tab: string) => {
    setActiveTab(tab);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    });
  };

  const { data: profile, isLoading } = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => businessProfileService.get(),
  });

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.pageTitle}>Business Knowledge</div>
          <div className={styles.pageSubtitle}>
            The AI's permanent business brain — every chat persona can draw on what's saved here.
          </div>
        </div>
      </div>

      <div className={styles.tabBar}>
        <Tabs items={TAB_ITEMS} activeId={activeTab} onChange={changeTab} />
      </div>

      {activeTab === 'overview' && <BusinessKnowledgeOverviewSection />}

      {activeTab === 'profile' && (
        <BusinessProfileForm
          profile={profile}
          isLoading={isLoading}
          canEdit={canEdit}
          onSaved={(saved) => queryClient.setQueryData(['business-profile'], saved)}
        />
      )}

      {activeTab === 'documents' && <BusinessKnowledgeDocumentsSection canEdit={canEdit} />}

      {activeTab === 'advisor' && <BusinessKnowledgeAdvisorSection />}

      {activeTab === 'recommendations' && <BusinessKnowledgeRecommendationsSection />}

      {activeTab === 'relationships' && <RelationshipsSection />}
    </div>
  );
}
