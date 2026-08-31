import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateCreditPackageDto {
  @IsString()
  @MinLength(1)
  key: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsInt()
  @Min(1)
  credits: number;

  @IsOptional() @IsInt() @Min(0) bonusCredits?: number;

  @IsNumber()
  @Min(0)
  price: number;

  @IsString()
  @MinLength(1)
  currency: string;

  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
