import { axiosClient } from '@/api/axiosClient';

// Phase 1 of the Business Advisor — a deterministic completeness/
// recommendations engine (backend/src/business-knowledge/business-knowledge-insights.service.ts)
// plus a dedicated, business-knowledge-only grounded chat endpoint
// (business-knowledge-chat.service.ts). Distinct from businessProfileService.ts
// (the structured profile form) and businessKnowledgeDocumentsService.ts
// (the document library) — this file covers the three new advisor routes.

export type BusinessKnowledgeCategoryId =
  | 'identity'
  | 'branches'
  | 'offering'
  | 'commercial_process'
  | 'sales_process'
  | 'customer_journey'
  | 'target_audience'
  | 'culture_faqs'
  | 'policies'
  | 'operating_guidance';

export interface CategoryCompleteness {
  id: BusinessKnowledgeCategoryId;
  label: string;
  pct: number;
  status: 'strong' | 'developing' | 'needs_attention';
  filledFields: number;
  totalFields: number;
  hasDocumentCoverage: boolean;
}

export interface CompletenessResult {
  overallPct: number;
  categories: CategoryCompleteness[];
  strong: string[];
  needsAttention: string[];
}

export type RecommendationPriority = 'high' | 'medium' | 'low' | 'opportunity';
export type RecommendationStatus = 'open' | 'in_progress' | 'completed' | 'dismissed';

export interface BusinessRecommendation {
  _id: string;
  organizationId: string;
  ruleKey: string;
  title: string;
  category: string;
  priority: RecommendationPriority;
  reason: string;
  evidence?: string;
  impact?: string;
  recommendedAction: string;
  status: RecommendationStatus;
  statusChangedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessKnowledgeChatSource {
  index: number;
  sourceType: string;
  documentId?: string;
  filename?: string;
  snippet: string;
}

export interface BusinessKnowledgeChatResult {
  answer: string;
  sources: BusinessKnowledgeChatSource[];
  creditsCharged: number;
}

export const businessKnowledgeAdvisorService = {
  async getCompleteness(): Promise<CompletenessResult> {
    const { data } = await axiosClient.get<CompletenessResult>('/business-knowledge/completeness');
    return data;
  },

  async listRecommendations(): Promise<BusinessRecommendation[]> {
    const { data } = await axiosClient.get<BusinessRecommendation[]>('/business-knowledge/recommendations');
    return data;
  },

  async updateRecommendationStatus(id: string, status: RecommendationStatus): Promise<BusinessRecommendation> {
    const { data } = await axiosClient.patch<BusinessRecommendation>(`/business-knowledge/recommendations/${id}`, { status });
    return data;
  },

  async ask(question: string): Promise<BusinessKnowledgeChatResult> {
    const { data } = await axiosClient.post<BusinessKnowledgeChatResult>('/business-knowledge/chat', { question });
    return data;
  },
};
