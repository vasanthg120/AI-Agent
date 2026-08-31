import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { BillingPageConfigService } from './billing-page-config.service';
import { BillingThemeService } from './billing-theme.service';
import { BillingPageConfig, BillingPageConfigDocument, BillingPageConfigSchema } from './schemas/billing-page-config.schema';
import { BillingTheme, BillingThemeDocument, BillingThemeSchema } from './schemas/billing-theme.schema';

// Real-Mongo integration tests for Phase 5's two singleton documents — same
// upsert-once-and-only-once pattern as BillingSettings (see
// billing-invoice.spec.ts's "BillingSettings singleton" tests), applied to
// BillingTheme/BillingPageConfig.

describe('BillingTheme / BillingPageConfig singletons (real Mongo)', () => {
  let connection: Connection;
  let themeService: BillingThemeService;
  let pageConfigService: BillingPageConfigService;
  let themeModel: Model<BillingThemeDocument>;
  let pageConfigModel: Model<BillingPageConfigDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: BillingTheme.name, schema: BillingThemeSchema },
          { name: BillingPageConfig.name, schema: BillingPageConfigSchema },
        ]),
      ],
      providers: [BillingThemeService, BillingPageConfigService],
    }).compile();

    connection = moduleRef.get(getModelToken(BillingTheme.name)).db;
    themeService = moduleRef.get(BillingThemeService);
    pageConfigService = moduleRef.get(BillingPageConfigService);
    themeModel = moduleRef.get(getModelToken(BillingTheme.name));
    pageConfigModel = moduleRef.get(getModelToken(BillingPageConfig.name));
  });

  afterAll(async () => {
    // Deliberately not deleting — both are real global singletons, same
    // reasoning as billing-invoice.spec.ts leaving BillingSettings alone.
    await connection.close();
  });

  describe('BillingTheme', () => {
    it('getTheme never creates more than one document, even under concurrent first-touch calls', async () => {
      await Promise.all(Array.from({ length: 5 }, () => themeService.getTheme()));
      const count = await themeModel.countDocuments({ singletonKey: 'default' });
      expect(count).toBe(1);
    });

    it('updateTheme persists tokens and is reflected on the next getTheme', async () => {
      await themeService.updateTheme({ tokens: { '--billing-accent': '#123456' }, logoUrl: 'https://example.com/logo.png' });
      const theme = await themeService.getTheme();
      expect(theme.tokens['--billing-accent']).toBe('#123456');
      expect(theme.logoUrl).toBe('https://example.com/logo.png');
    });
  });

  describe('BillingPageConfig', () => {
    it('getPageConfig never creates more than one document, even under concurrent first-touch calls', async () => {
      await Promise.all(Array.from({ length: 5 }, () => pageConfigService.getPageConfig()));
      const count = await pageConfigModel.countDocuments({ singletonKey: 'default' });
      expect(count).toBe(1);
    });

    it('updatePageConfig persists hero copy, FAQ entries, and displayed plan order', async () => {
      await pageConfigService.updatePageConfig({
        heroHeadline: 'Simple, transparent pricing',
        heroSubtext: 'Pick the plan that fits your team.',
        faqEntries: [{ question: 'Can I cancel anytime?', answer: 'Yes, at the end of your billing period.' }],
        displayedPlanIds: ['plan-a', 'plan-b'],
      });
      const config = await pageConfigService.getPageConfig();
      expect(config.heroHeadline).toBe('Simple, transparent pricing');
      expect(config.faqEntries).toHaveLength(1);
      expect(config.displayedPlanIds).toEqual(['plan-a', 'plan-b']);
    });
  });
});
