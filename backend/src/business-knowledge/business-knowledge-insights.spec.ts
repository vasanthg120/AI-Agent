import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { BusinessKnowledgeInsightsService } from './business-knowledge-insights.service';
import { BusinessKnowledgeDocument, BusinessKnowledgeDocumentDocument, BusinessKnowledgeDocumentSchema } from './schemas/business-knowledge-document.schema';
import { BusinessProfile, BusinessProfileDocument, BusinessProfileSchema } from './schemas/business-profile.schema';
import { BusinessRecommendation, BusinessRecommendationDocument, BusinessRecommendationSchema } from './schemas/business-recommendation.schema';

// Real-Mongo integration tests for the Phase 1 Business Advisor's
// deterministic completeness engine and rule-based recommendation
// generator (business-knowledge-insights.service.ts) — no LLM/python-agent
// involved, this is pure Mongo-driven business logic.

const TEST_PREFIX = `jest-bk-insights-${Date.now()}`;

describe('BusinessKnowledgeInsightsService (real Mongo)', () => {
  let connection: Connection;
  let service: BusinessKnowledgeInsightsService;
  let profileModel: Model<BusinessProfileDocument>;
  let documentModel: Model<BusinessKnowledgeDocumentDocument>;
  let recommendationModel: Model<BusinessRecommendationDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: BusinessProfile.name, schema: BusinessProfileSchema },
          { name: BusinessKnowledgeDocument.name, schema: BusinessKnowledgeDocumentSchema },
          { name: BusinessRecommendation.name, schema: BusinessRecommendationSchema },
        ]),
      ],
      providers: [BusinessKnowledgeInsightsService],
    }).compile();

    connection = moduleRef.get(getModelToken(BusinessProfile.name)).db;
    service = moduleRef.get(BusinessKnowledgeInsightsService);
    profileModel = moduleRef.get(getModelToken(BusinessProfile.name));
    documentModel = moduleRef.get(getModelToken(BusinessKnowledgeDocument.name));
    recommendationModel = moduleRef.get(getModelToken(BusinessRecommendation.name));
  });

  afterAll(async () => {
    await profileModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await documentModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await recommendationModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('returns 0% completeness for an org with no profile and no documents', async () => {
    const organizationId = `${TEST_PREFIX}-empty`;
    const result = await service.getCompleteness(organizationId);
    expect(result.overallPct).toBe(0);
    expect(result.categories.every((c) => c.pct === 0)).toBe(true);
    expect(result.strong).toEqual([]);
  });

  it('computes correct per-category percentages from a partial profile', async () => {
    const organizationId = `${TEST_PREFIX}-partial`;
    await profileModel.create({
      organizationId,
      businessName: 'Acme',
      description: 'Widgets',
      industry: 'Manufacturing',
      website: 'acme.example',
      // identity fully filled -> 100%; every other category empty -> 0%
    });

    const result = await service.getCompleteness(organizationId);
    const identity = result.categories.find((c) => c.id === 'identity')!;
    expect(identity.pct).toBe(100);
    expect(identity.status).toBe('strong');
    const offering = result.categories.find((c) => c.id === 'offering')!;
    expect(offering.pct).toBe(0);
    expect(offering.status).toBe('needs_attention');
  });

  it('credits a category via a reviewed, completed document even when the profile field is empty', async () => {
    const organizationId = `${TEST_PREFIX}-doc-bonus`;
    await profileModel.create({ organizationId }); // offering fields all empty

    // Not yet reviewed -> no bonus
    await documentModel.create({
      organizationId,
      uploadedBy: 'tester',
      originalFilename: 'catalog-draft.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-gridfs-1',
      fileFormat: 'pdf',
      assetType: 'product_catalog',
      extractionStatus: 'completed',
      reviewStatus: 'needs_review',
    });
    let result = await service.getCompleteness(organizationId);
    expect(result.categories.find((c) => c.id === 'offering')!.hasDocumentCoverage).toBe(false);

    await documentModel.create({
      organizationId,
      uploadedBy: 'tester',
      originalFilename: 'catalog.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-gridfs-2',
      fileFormat: 'pdf',
      assetType: 'product_catalog',
      extractionStatus: 'completed',
      reviewStatus: 'reviewed',
    });
    result = await service.getCompleteness(organizationId);
    const offering = result.categories.find((c) => c.id === 'offering')!;
    expect(offering.hasDocumentCoverage).toBe(true);
    expect(offering.pct).toBe(25); // 0% from fields + the fixed document bonus
  });

  it('generates a recommendation for a missing rule field, and auto-completes it once the gap closes', async () => {
    const organizationId = `${TEST_PREFIX}-recs`;
    await profileModel.create({ organizationId }); // refundPolicy missing

    await service.getCompleteness(organizationId);
    let recs = await recommendationModel.find({ organizationId, ruleKey: 'refundPolicy' }).exec();
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe('open');
    expect(recs[0].title).toBe('Create Refund Policy');

    // Re-running must not duplicate the row.
    await service.getCompleteness(organizationId);
    recs = await recommendationModel.find({ organizationId, ruleKey: 'refundPolicy' }).exec();
    expect(recs).toHaveLength(1);

    // Fill the gap -> the existing open recommendation auto-completes.
    await profileModel.updateOne({ organizationId }, { $set: { refundPolicy: 'Refunds within 14 days.' } });
    await service.getCompleteness(organizationId);
    const resolved = await recommendationModel.findOne({ organizationId, ruleKey: 'refundPolicy' }).exec();
    expect(resolved?.status).toBe('completed');
  });

  it('never resurrects a dismissed recommendation even if the gap reopens', async () => {
    const organizationId = `${TEST_PREFIX}-dismiss`;
    await profileModel.create({ organizationId, refundPolicy: 'Refunds within 14 days.' });
    await service.getCompleteness(organizationId); // no gap yet, nothing created

    await profileModel.updateOne({ organizationId }, { $unset: { refundPolicy: '' } });
    await service.getCompleteness(organizationId);
    const created = await recommendationModel.findOne({ organizationId, ruleKey: 'refundPolicy' }).exec();
    expect(created?.status).toBe('open');

    await service.updateRecommendationStatus(organizationId, created!._id.toString(), 'dismissed');
    await service.getCompleteness(organizationId); // gap still open
    const stillDismissed = await recommendationModel.findOne({ organizationId, ruleKey: 'refundPolicy' }).exec();
    expect(stillDismissed?.status).toBe('dismissed');
  });
});
