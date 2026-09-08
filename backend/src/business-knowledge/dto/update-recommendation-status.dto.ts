import { IsIn } from 'class-validator';
import { RECOMMENDATION_STATUSES, RecommendationStatus } from '../schemas/business-recommendation.schema';

export class UpdateRecommendationStatusDto {
  @IsIn(RECOMMENDATION_STATUSES)
  status: RecommendationStatus;
}
