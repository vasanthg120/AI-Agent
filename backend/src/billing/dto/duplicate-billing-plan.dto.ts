import { IsString, MinLength } from 'class-validator';

export class DuplicateBillingPlanDto {
  @IsString()
  @MinLength(1)
  key: string;
}
