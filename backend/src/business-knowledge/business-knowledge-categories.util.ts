import { BusinessKnowledgeAssetType } from './schemas/business-knowledge-document.schema';
import { BusinessProfile } from './schemas/business-profile.schema';

// The spec's exact 10-category framework — every field on BusinessProfile
// (and every document assetType) maps to exactly one of these. This is the
// single source of truth for "what does completeness/a recommendation mean
// by 'Policies'" — business-knowledge-insights.service.ts and the frontend
// Overview tab both key off these ids/labels.
export const BUSINESS_KNOWLEDGE_CATEGORIES = [
  { id: 'identity', label: 'Identity' },
  { id: 'branches', label: 'Branches / Locations' },
  { id: 'offering', label: 'Offering' },
  { id: 'commercial_process', label: 'Commercial Process' },
  { id: 'sales_process', label: 'Sales Process' },
  { id: 'customer_journey', label: 'Customer Journey' },
  { id: 'target_audience', label: 'Target Audience' },
  { id: 'culture_faqs', label: 'Culture & FAQs' },
  { id: 'policies', label: 'Policies' },
  { id: 'operating_guidance', label: 'Operating Guidance' },
] as const;
export type BusinessKnowledgeCategoryId = (typeof BUSINESS_KNOWLEDGE_CATEGORIES)[number]['id'];

// A single BusinessProfile field, scoped to one category. `type` decides
// how "filled" is checked (plain string vs. a string[]/object[] length).
// This list is the same 25 fields business-profile.service.ts's old flat
// completenessPct already counted (4+1+3+1+1+1+1+4+4+5 = 25) — reorganized
// per category, not expanded, so the overall % stays comparable to before.
interface ProfileFieldSpec {
  field: keyof BusinessProfile;
  category: BusinessKnowledgeCategoryId;
  type: 'text' | 'list';
  // Human label for the recommendation this field generates when missing —
  // absent for fields the rule engine doesn't generate a standalone
  // recommendation for (see business-knowledge-insights.service.ts's
  // RECOMMENDATION_RULES for those that do).
}
export const PROFILE_FIELD_SPECS: ProfileFieldSpec[] = [
  { field: 'businessName', category: 'identity', type: 'text' },
  { field: 'description', category: 'identity', type: 'text' },
  { field: 'industry', category: 'identity', type: 'text' },
  { field: 'website', category: 'identity', type: 'text' },

  { field: 'branches', category: 'branches', type: 'list' },

  { field: 'products', category: 'offering', type: 'list' },
  { field: 'services', category: 'offering', type: 'list' },
  { field: 'brands', category: 'offering', type: 'list' },

  { field: 'pricingPolicies', category: 'commercial_process', type: 'text' },

  { field: 'salesProcess', category: 'sales_process', type: 'text' },

  { field: 'customerJourney', category: 'customer_journey', type: 'text' },

  { field: 'targetAudience', category: 'target_audience', type: 'text' },

  { field: 'vision', category: 'culture_faqs', type: 'text' },
  { field: 'mission', category: 'culture_faqs', type: 'text' },
  { field: 'values', category: 'culture_faqs', type: 'list' },
  { field: 'faqs', category: 'culture_faqs', type: 'list' },

  { field: 'termsAndConditions', category: 'policies', type: 'text' },
  { field: 'warrantyPolicy', category: 'policies', type: 'text' },
  { field: 'refundPolicy', category: 'policies', type: 'text' },
  { field: 'shippingPolicy', category: 'policies', type: 'text' },

  { field: 'businessRules', category: 'operating_guidance', type: 'text' },
  { field: 'standardOperatingProcedures', category: 'operating_guidance', type: 'text' },
  { field: 'salesGuidelines', category: 'operating_guidance', type: 'text' },
  { field: 'marketingGuidelines', category: 'operating_guidance', type: 'text' },
  { field: 'internalPolicies', category: 'operating_guidance', type: 'text' },
];

// Deterministic assetType -> category bonus mapping (spec §13: "combine
// structured profile + document knowledge before deciding something is
// missing"). A category with no entry here simply never gets a document
// bonus — e.g. nothing in the 12-asset-type catalog cleanly represents
// "Branches/Locations" or "Culture & FAQs", so those stay profile-field-only
// rather than force a misleading mapping.
export const ASSET_TYPE_CATEGORY_BONUS: Partial<Record<BusinessKnowledgeAssetType, BusinessKnowledgeCategoryId[]>> = {
  product_catalog: ['offering'],
  brochure: ['offering'],
  marketing_material: ['offering'],
  price_list: ['offering', 'commercial_process'],
  quotation: ['commercial_process'],
  sales_deck: ['sales_process'],
  agreement: ['policies'],
  company_profile: ['identity'],
  brand_guideline: ['identity'],
  internal_manual: ['operating_guidance'],
  vendor_document: ['operating_guidance'],
};

// Fixed, documented constant — not tuned per org, not LLM-decided (spec §3:
// "the completeness engine must be deterministic and explainable... do not
// allow the LLM alone to randomly decide the percentage").
export const DOCUMENT_COVERAGE_BONUS_PCT = 25;

export function isFieldFilled(profile: BusinessProfile, spec: ProfileFieldSpec): boolean {
  const value = profile[spec.field];
  if (spec.type === 'list') return Array.isArray(value) && value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}
