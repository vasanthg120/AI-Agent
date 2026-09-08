import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AskBusinessKnowledgeDto } from './dto/ask-business-knowledge.dto';
import { UpdateRecommendationStatusDto } from './dto/update-recommendation-status.dto';
import { BusinessKnowledgeChatService } from './business-knowledge-chat.service';
import { BusinessKnowledgeInsightsService } from './business-knowledge-insights.service';

// Same read tier as the rest of business-knowledge (owner/admin/manager) —
// see business-profile.controller.ts's own comment for why. Recommendation
// status changes and asking the advisor are both considered ordinary
// operational actions here (not mutating shared company knowledge the way
// editing the profile is), so they stay at the class-level tier rather than
// the tighter owner/admin-only override the profile PUT route uses.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Controller('business-knowledge')
export class BusinessKnowledgeAdvisorController {
  constructor(
    private insights: BusinessKnowledgeInsightsService,
    private chat: BusinessKnowledgeChatService,
  ) {}

  @Get('completeness')
  getCompleteness(@CurrentUser() user: JwtPayload) {
    return this.insights.getCompleteness(user.organizationId);
  }

  @Get('recommendations')
  listRecommendations(@CurrentUser() user: JwtPayload) {
    return this.insights.listRecommendations(user.organizationId);
  }

  @Patch('recommendations/:id')
  updateRecommendation(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateRecommendationStatusDto) {
    return this.insights.updateRecommendationStatus(user.organizationId, id, dto.status);
  }

  @Post('chat')
  ask(@CurrentUser() user: JwtPayload, @Body() dto: AskBusinessKnowledgeDto) {
    return this.chat.ask(user.organizationId, user.sub, dto.question);
  }
}
