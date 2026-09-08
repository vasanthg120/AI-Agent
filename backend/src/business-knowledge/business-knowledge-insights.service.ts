import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ASSET_TYPE_CATEGORY_BONUS,
  BUSINESS_KNOWLEDGE_CATEGORIES,
  BusinessKnowledgeCategoryId,
  DOCUMENT_COVERAGE_BONUS_PCT,
  isFieldFilled,
  PROFILE_FIELD_SPECS,
} from './business-knowledge-categories.util';
import { BusinessKnowledgeDocument, BusinessKnowledgeDocumentDocument } from './schemas/business-knowledge-document.schema';
import { BusinessProfile, BusinessProfileDocument } from './schemas/business-profile.schema';
import { BusinessRecommendation, BusinessRecommendationDocument, RecommendationStatus } from './schemas/business-recommendation.schema';

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

// Rule-based v1 recommendation generator (spec §16-17) — every row is
// derived directly from a PROFILE_FIELD_SPECS gap, never an LLM guessing at
// what's missing. Only the fields the spec itself calls out by name get a
// standalone recommendation; the rest of PROFILE_FIELD_SPECS still count
// toward completeness but don't generate their own rule row.
interface RecommendationRule {
  field: (typeof PROFILE_FIELD_SPECS)[number]['field'];
  category: BusinessKnowledgeCategoryId;
  title: string;
  priority: 'high' | 'medium' | 'low';
  reason: string;
  action: string;
}
const RECOMMENDATION_RULES: RecommendationRule[] = [
  {
    field: 'refundPolicy',
    category: 'policies',
    title: 'Create Refund Policy',
    priority: 'high',
    reason: 'No refund policy was found in your business profile or documents.',
    action: 'Define eligibility, refund timelines, exceptions, and the approval process.',
  },
  {
    field: 'termsAndConditions',
    category: 'policies',
    title: 'Create Terms & Conditions',
    priority: 'high',
    reason: 'No terms & conditions were found in your business profile or documents.',
    action: 'Document the commercial terms customers agree to when they do business with you.',
  },
  {
    field: 'warrantyPolicy',
    category: 'policies',
    title: 'Create Warranty Policy',
    priority: 'medium',
    reason: 'No warranty policy was found in your business profile or documents.',
    action: 'Define what is covered, for how long, and how a claim is made.',
  },
  {
    field: 'shippingPolicy',
    category: 'policies',
    title: 'Create Shipping Policy',
    priority: 'medium',
    reason: 'No shipping policy was found in your business profile or documents.',
    action: 'Document delivery timelines, costs, and coverage areas.',
  },
  {
    field: 'salesProcess',
    category: 'sales_process',
    title: 'Define Your Sales Process',
    priority: 'high',
    reason: 'No sales process is documented — lead handling, qualification, and closing steps are undefined.',
    action: 'Write down the stages a lead moves through from first contact to close, and who owns each one.',
  },
  {
    field: 'customerJourney',
    category: 'customer_journey',
    title: 'Map Your Customer Journey',
    priority: 'high',
    reason: 'No customer journey is documented — it is unclear what a customer experiences from lead to retention.',
    action: 'Outline each stage a customer passes through, from first contact to repeat purchase.',
  },
  {
    field: 'targetAudience',
    category: 'target_audience',
    title: 'Define Your Target Audience',
    priority: 'high',
    reason: 'No target audience is documented — segments, ideal customer profile, and pain points are undefined.',
    action: 'Describe who your ideal customers are, their needs, and their buying behavior.',
  },
  {
    field: 'pricingPolicies',
    category: 'commercial_process',
    title: 'Document Pricing Policies',
    priority: 'medium',
    reason: 'No pricing policy is documented — discounting and payment rules are undefined.',
    action: 'Write down your standard pricing rules, discount policy, and payment terms.',
  },
  {
    field: 'standardOperatingProcedures',
    category: 'operating_guidance',
    title: 'Document Standard Operating Procedures',
    priority: 'medium',
    reason: 'No SOPs are documented — day-to-day operational steps rely on individual memory.',
    action: 'Write down the standard steps for your most repeated operational tasks.',
  },
  {
    field: 'salesGuidelines',
    category: 'operating_guidance',
    title: 'Document Sales Guidelines',
    priority: 'medium',
    reason: 'No sales guidelines are documented for the team to follow consistently.',
    action: 'Write down the guidelines sales reps should follow, from outreach to close.',
  },
  {
    field: 'marketingGuidelines',
    category: 'operating_guidance',
    title: 'Document Marketing Guidelines',
    priority: 'low',
    reason: 'No marketing guidelines are documented.',
    action: 'Write down brand voice, channels, and campaign approval guidelines.',
  },
  {
    field: 'businessRules',
    category: 'operating_guidance',
    title: 'Document Business Rules',
    priority: 'low',
    reason: 'No general business rules are documented.',
    action: 'Write down the operational rules your team should follow by default.',
  },
];

/**
 * Phase 1 of the Business Advisor — a deterministic, rule-based completeness
 * engine and recommendation generator built directly on the existing
 * BusinessProfile + BusinessKnowledgeDocument schemas (no new profile/doc
 * schema, no LLM call in this file). Replaces business-profile.service.ts's
 * old flat completenessPct (a single 25-field ratio) with a per-category
 * breakdown that also credits document knowledge, per the spec's explicit
 * "combine structured profile + documents before deciding something is
 * missing" requirement.
 */
@Injectable()
export class BusinessKnowledgeInsightsService {
  constructor(
    @InjectModel(BusinessProfile.name) private profileModel: Model<BusinessProfileDocument>,
    @InjectModel(BusinessKnowledgeDocument.name) private documentModel: Model<BusinessKnowledgeDocumentDocument>,
    @InjectModel(BusinessRecommendation.name) private recommendationModel: Model<BusinessRecommendationDocument>,
  ) {}

  async getCompleteness(organizationId: string): Promise<CompletenessResult> {
    const profile = await this.profileModel.findOne({ organizationId }).exec();
    const result = await this.computeCompleteness(organizationId, profile);
    await this.refreshRecommendations(organizationId, profile);
    return result;
  }

  async listRecommendations(organizationId: string) {
    // Recompute first so a direct GET /recommendations call (not preceded by
    // a completeness fetch) still reflects the latest profile/document state.
    await this.getCompleteness(organizationId);
    return this.recommendationModel.find({ organizationId }).sort({ priority: 1, createdAt: 1 }).exec();
  }

  async updateRecommendationStatus(organizationId: string, id: string, status: RecommendationStatus): Promise<BusinessRecommendationDocument> {
    const rec = await this.recommendationModel.findOneAndUpdate(
      { _id: id, organizationId },
      { $set: { status, statusChangedAt: new Date() } },
      { new: true },
    ).exec();
    if (!rec) throw new NotFoundException('Recommendation not found.');
    return rec;
  }

  /** Exported for reuse by business-profile.service.ts, so the existing
   * GET/PUT /business-knowledge/profile responses' completenessPct field
   * stays a single number consistent with this engine (the average of the
   * category percentages below) instead of two divergent calculations. */
  async overallCompletenessPct(organizationId: string): Promise<number> {
    const result = await this.getCompleteness(organizationId);
    return result.overallPct;
  }

  private async computeCompleteness(organizationId: string, profile: BusinessProfileDocument | null): Promise<CompletenessResult> {
    const coveredCategories = await this.documentCoveredCategories(organizationId);

    const categories: CategoryCompleteness[] = BUSINESS_KNOWLEDGE_CATEGORIES.map(({ id, label }) => {
      const specs = PROFILE_FIELD_SPECS.filter((s) => s.category === id);
      const filledFields = profile ? specs.filter((s) => isFieldFilled(profile, s)).length : 0;
      const fieldPct = specs.length > 0 ? (filledFields / specs.length) * 100 : 0;
      const hasDocumentCoverage = coveredCategories.has(id);
      const pct = Math.min(100, Math.round(fieldPct + (hasDocumentCoverage ? DOCUMENT_COVERAGE_BONUS_PCT : 0)));
      const status: CategoryCompleteness['status'] = pct >= 70 ? 'strong' : pct < 50 ? 'needs_attention' : 'developing';
      return { id, label, pct, status, filledFields, totalFields: specs.length, hasDocumentCoverage };
    });

    const overallPct = Math.round(categories.reduce((sum, c) => sum + c.pct, 0) / categories.length);
    return {
      overallPct,
      categories,
      strong: categories.filter((c) => c.status === 'strong').map((c) => c.label),
      needsAttention: categories.filter((c) => c.status === 'needs_attention').map((c) => c.label),
    };
  }

  /** Which categories have at least one reviewed, successfully-extracted
   * document whose assetType maps to them (ASSET_TYPE_CATEGORY_BONUS). */
  private async documentCoveredCategories(organizationId: string): Promise<Set<BusinessKnowledgeCategoryId>> {
    const docs = await this.documentModel
      .find({ organizationId, extractionStatus: 'completed', reviewStatus: 'reviewed' })
      .select({ assetType: 1 })
      .exec();
    const covered = new Set<BusinessKnowledgeCategoryId>();
    for (const doc of docs) {
      for (const category of ASSET_TYPE_CATEGORY_BONUS[doc.assetType] ?? []) covered.add(category);
    }
    return covered;
  }

  /** Upserts one recommendation row per RECOMMENDATION_RULES entry whose
   * field is currently missing (by the same combined profile+document
   * signal computeCompleteness used), keyed by ruleKey so re-running never
   * duplicates. A rule whose gap has closed auto-completes its row unless
   * the user already dismissed it — never resurrects a dismissed one. */
  private async refreshRecommendations(organizationId: string, profile: BusinessProfileDocument | null): Promise<void> {
    const coveredCategories = await this.documentCoveredCategories(organizationId);

    for (const rule of RECOMMENDATION_RULES) {
      const spec = PROFILE_FIELD_SPECS.find((s) => s.field === rule.field);
      const fieldFilled = profile && spec ? isFieldFilled(profile, spec) : false;
      const categoryCoveredByDocs = coveredCategories.has(rule.category);
      const gapOpen = !fieldFilled && !categoryCoveredByDocs;

      const existing = await this.recommendationModel.findOne({ organizationId, ruleKey: rule.field }).exec();

      if (gapOpen) {
        if (existing) continue; // already tracked (open/in_progress/completed/dismissed) — leave the user's state alone
        await this.recommendationModel.create({
          organizationId,
          ruleKey: rule.field,
          title: rule.title,
          category: BUSINESS_KNOWLEDGE_CATEGORIES.find((c) => c.id === rule.category)?.label ?? rule.category,
          priority: rule.priority,
          reason: rule.reason,
          recommendedAction: rule.action,
          status: 'open',
        });
      } else if (existing && (existing.status === 'open' || existing.status === 'in_progress')) {
        // The gap closed on its own (field filled, or a covering document
        // was added/reviewed) — auto-complete, but never touch a row the
        // user already dismissed or already marked completed themselves.
        existing.status = 'completed';
        existing.statusChangedAt = new Date();
        await existing.save();
      }
    }
  }
}
