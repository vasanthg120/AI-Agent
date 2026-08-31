import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateBillingFeatureDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
