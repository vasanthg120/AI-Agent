import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { BusinessProfile, BusinessProfileSchema } from './schemas/business-profile.schema';
import { BusinessKnowledgeDocument, BusinessKnowledgeDocumentSchema } from './schemas/business-knowledge-document.schema';
import { BusinessRecommendation, BusinessRecommendationSchema } from './schemas/business-recommendation.schema';
import { BusinessProfileController } from './business-profile.controller';
import { BusinessProfileService } from './business-profile.service';
import { BusinessKnowledgeDocumentsController } from './business-knowledge-documents.controller';
import { BusinessKnowledgeDocumentsService } from './business-knowledge-documents.service';
import { BusinessKnowledgeGridFsService } from './business-knowledge-gridfs.service';
import { BusinessKnowledgeAdvisorController } from './business-knowledge-advisor.controller';
import { BusinessKnowledgeChatService } from './business-knowledge-chat.service';
import { BusinessKnowledgeInsightsService } from './business-knowledge-insights.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BusinessProfile.name, schema: BusinessProfileSchema },
      { name: BusinessKnowledgeDocument.name, schema: BusinessKnowledgeDocumentSchema },
      { name: BusinessRecommendation.name, schema: BusinessRecommendationSchema },
    ]),
    AuthModule,
    // Phase 1 Business Advisor — reuses ReservationService.reserve/settle/release
    // as-is for the new chat route (see business-knowledge-chat.service.ts);
    // nothing else from BillingModule is used here.
    BillingModule,
    // Generous timeout — both the profile sync call and document extraction
    // block on real Claude calls synchronously, same reasoning as
    // finance.module.ts's identical setting.
    HttpModule.register({ timeout: 60_000 }),
  ],
  controllers: [BusinessProfileController, BusinessKnowledgeDocumentsController, BusinessKnowledgeAdvisorController],
  providers: [
    BusinessProfileService,
    GridFsService,
    BusinessKnowledgeGridFsService,
    BusinessKnowledgeDocumentsService,
    BusinessKnowledgeInsightsService,
    BusinessKnowledgeChatService,
  ],
})
export class BusinessKnowledgeModule {}
