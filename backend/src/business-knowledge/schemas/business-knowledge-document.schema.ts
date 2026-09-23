import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BusinessKnowledgeDocumentDocument = BusinessKnowledgeDocument & Document<Types.ObjectId>;

// Every asset type named in the spec (catalog, brochure, quotation, price
// list, agreement, vendor document, company profile, sales deck, marketing
// material, brand guideline, internal manual) goes through the identical
// GridFS -> extract -> index pipeline, differing only in classification —
// one schema discriminated by assetType, mirroring FinanceDocument's own
// one-schema/documentFormat-discriminator precedent, not eleven near-
// identical schemas.
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
  // The Business Profile's document-based Terms & Conditions upload (see
  // BusinessKnowledgeDocumentsService's generic upload/extract/delete flow —
  // unchanged; this is purely a classification value, treated as a
  // singleton-per-org by convention in the frontend's TermsAndConditionsPolicy
  // component, "latest wins" via Replace Document deleting the old one first).
  'terms_and_conditions',
  'other',
] as const;
export type BusinessKnowledgeAssetType = (typeof ASSET_TYPES)[number];

@Schema({ timestamps: true, collection: 'business_knowledge_documents' })
export class BusinessKnowledgeDocument {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ index: true })
  uploadedBy: string;

  // ---- file / storage ----
  @Prop({ required: true })
  originalFilename: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  fileSizeBytes: number;

  @Prop({ required: true })
  gridFsFileId: string;

  @Prop({ enum: ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'image', 'html', 'txt', 'md'], required: true })
  fileFormat: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'xls' | 'csv' | 'image' | 'html' | 'txt' | 'md';

  // ---- classification ----
  @Prop({ enum: ASSET_TYPES, required: true, index: true })
  assetType: BusinessKnowledgeAssetType;

  // AI-suggested short human title, editable — same "judgment field, always
  // a confident answer" philosophy as assetType (see Phase 14a plan notes'
  // extraction-philosophy discussion).
  @Prop()
  title?: string;

  // ---- processing lifecycle ----
  @Prop({ enum: ['processing', 'completed', 'failed'], default: 'processing', index: true })
  extractionStatus: 'processing' | 'completed' | 'failed';

  @Prop()
  extractionError?: string;

  // Never a gate on retrievability — a document counts (is embedded and
  // chat-reachable) the instant extraction completes, regardless of human
  // review, same "shared instantly" decision as Finance's own precedent
  // (confirmed with the user before building this). Only drives a "needs
  // review" banner/count.
  @Prop({ enum: ['needs_review', 'reviewed'], default: 'needs_review', index: true })
  reviewStatus: 'needs_review' | 'reviewed';

  @Prop()
  reviewedBy?: string;

  @Prop()
  reviewedAt?: Date;

  // ---- AI output ----
  @Prop()
  aiSummary?: string;

  @Prop({ type: [String], default: [] })
  keyTopics: string[];

  // Concrete named entities/figures actually present (product names, SKUs,
  // prices, dates, contacts, vendor names) — only what the document
  // explicitly states, never inferred (the "factual field" half of the
  // hybrid extraction philosophy).
  @Prop({ type: Object, default: {} })
  extractedEntities: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  missingFields: string[];

  @Prop({ type: [String], default: [] })
  inconsistencyNotes: string[];

  // ---- RAG linkage ----
  @Prop()
  vectorDocumentId?: string;

  @Prop({ default: 0 })
  vectorChunkCount: number;

  createdAt: Date;
  updatedAt: Date;
}

export const BusinessKnowledgeDocumentSchema = SchemaFactory.createForClass(BusinessKnowledgeDocument);
BusinessKnowledgeDocumentSchema.index({ organizationId: 1, createdAt: -1 });
BusinessKnowledgeDocumentSchema.index({ organizationId: 1, assetType: 1 });
