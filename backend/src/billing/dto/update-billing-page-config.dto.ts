import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

class BillingFaqEntryDto {
  @IsString() question: string;
  @IsString() answer: string;
}

export class UpdateBillingPageConfigDto {
  @IsOptional() @IsString() heroHeadline?: string;
  @IsOptional() @IsString() heroSubtext?: string;
  @IsOptional() @IsString() ctaButtonText?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BillingFaqEntryDto)
  faqEntries?: BillingFaqEntryDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  displayedPlanIds?: string[];
}
