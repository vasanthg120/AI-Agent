import { axiosClient } from '@/api/axiosClient';

export const ASSET_TYPES = [
  'product_catalog',
  'brochure',
  'quotation',
  'price_list',
  'agreement',
  'vendor_document',
  'company_profile',
  'sales_deck',
  'marketing_material',
  'brand_guideline',
  'internal_manual',
  'terms_and_conditions',
  'other',
] as const;

export interface BusinessKnowledgeDocument {
  _id: string;
  organizationId: string;
  uploadedBy: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  gridFsFileId: string;
  fileFormat: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'xls' | 'csv' | 'image' | 'html' | 'txt' | 'md';
  assetType: (typeof ASSET_TYPES)[number];
  title?: string;
  extractionStatus: 'processing' | 'completed' | 'failed';
  extractionError?: string;
  reviewStatus: 'needs_review' | 'reviewed';
  reviewedBy?: string;
  reviewedAt?: string;
  aiSummary?: string;
  keyTopics: string[];
  extractedEntities: Record<string, unknown>;
  missingFields: string[];
  inconsistencyNotes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BusinessKnowledgeDocumentFilters {
  assetType?: string[];
  extractionStatus?: string;
  reviewStatus?: 'needs_review' | 'reviewed';
  search?: string;
}

export interface UpdateBusinessKnowledgeDocumentPayload {
  title?: string;
  assetType?: (typeof ASSET_TYPES)[number];
  keyTopics?: string[];
}

export interface ListBusinessKnowledgeDocumentsResult {
  items: BusinessKnowledgeDocument[];
  total: number;
  page: number;
  pageSize: number;
}

function toFilterParams(filters: BusinessKnowledgeDocumentFilters, extra?: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...extra };
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    params[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return params;
}

export const businessKnowledgeDocumentsService = {
  async upload(file: File): Promise<BusinessKnowledgeDocument> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<BusinessKnowledgeDocument>('/business-knowledge/documents', form);
    return data;
  },

  async listFiltered(
    filters: BusinessKnowledgeDocumentFilters,
    page: number,
    pageSize: number,
  ): Promise<ListBusinessKnowledgeDocumentsResult> {
    const { data } = await axiosClient.get<ListBusinessKnowledgeDocumentsResult>('/business-knowledge/documents/query', {
      params: toFilterParams(filters, { page, pageSize }),
    });
    return data;
  },

  async getOne(id: string): Promise<BusinessKnowledgeDocument> {
    const { data } = await axiosClient.get<BusinessKnowledgeDocument>(`/business-knowledge/documents/${id}`);
    return data;
  },

  async update(id: string, payload: UpdateBusinessKnowledgeDocumentPayload): Promise<BusinessKnowledgeDocument> {
    const { data } = await axiosClient.patch<BusinessKnowledgeDocument>(`/business-knowledge/documents/${id}`, payload);
    return data;
  },

  async retryExtraction(id: string): Promise<BusinessKnowledgeDocument> {
    const { data } = await axiosClient.post<BusinessKnowledgeDocument>(`/business-knowledge/documents/${id}/retry-extraction`);
    return data;
  },

  async remove(id: string): Promise<void> {
    await axiosClient.delete(`/business-knowledge/documents/${id}`);
  },

  async viewFile(id: string): Promise<void> {
    const response = await axiosClient.get(`/business-knowledge/documents/${id}/file`, { responseType: 'blob' });
    const url = URL.createObjectURL(response.data as Blob);
    window.open(url, '_blank');
  },
};
