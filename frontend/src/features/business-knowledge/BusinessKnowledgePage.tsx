import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { businessProfileService } from '@/services/businessProfileService';
import { BusinessProfileForm } from './components/BusinessProfileForm';
import { BusinessKnowledgeDocumentsSection } from './components/BusinessKnowledgeDocumentsSection';
import styles from './business-knowledge.module.css';

// Overview/AI Advisor/Recommendations/Relationships tabs were removed —
// this page now only manages the two things that actually become permanent,
// agent-retrievable Business Knowledge (the profile and uploaded documents).
// Their backend routes/services are untouched (still used elsewhere or kept
// as working, callable endpoints — see business-knowledge-advisor.controller.ts);
// only this page's UI integration with them was removed. Business Knowledge
// Q&A now happens exclusively through the existing agentic Chat/AI Assistant
// (search_business_context already retrieves business_profile/
// business_knowledge_document Qdrant points org-scoped — see
// python-agent/app/tools/business_search_tool.py), not a dedicated advisor here.
const TAB_ITEMS = [
  { id: 'profile', label: 'Business Profile' },
  { id: 'documents', label: 'Documents' },
];
const TAB_IDS = TAB_ITEMS.map((t) => t.id);

export function BusinessKnowledgePage() {
  const user = useAuthStore((s) => s.user);
  const canEdit = hasRole(user, 'owner') || hasRole(user, 'admin');
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(initialTab && TAB_IDS.includes(initialTab) ? initialTab : 'profile');

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

      {activeTab === 'profile' && (
        <BusinessProfileForm
          profile={profile}
          isLoading={isLoading}
          canEdit={canEdit}
          onSaved={(saved) => queryClient.setQueryData(['business-profile'], saved)}
        />
      )}

      {activeTab === 'documents' && <BusinessKnowledgeDocumentsSection canEdit={canEdit} />}
    </div>
  );
}
