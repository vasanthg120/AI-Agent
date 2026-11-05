import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : value === 'true'))
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  vendorId?: string;

  // Omitted entirely = 'product' (the Products tab's own default view, so an
  // existing caller that never sends this param keeps seeing exactly what it
  // saw before this field existed — Pre-Built Items only ever show up when
  // explicitly asked for).
  @IsOptional()
  @IsIn(['product', 'prebuilt'])
  kind?: 'product' | 'prebuilt';

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
