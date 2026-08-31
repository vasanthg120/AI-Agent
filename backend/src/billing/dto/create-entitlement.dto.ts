import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { ENTITLEMENT_TYPES, EntitlementType } from '../schemas/entitlement.schema';

export class CreateEntitlementDto {
  @IsString()
  @MinLength(1)
  key: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsIn(ENTITLEMENT_TYPES)
  type: EntitlementType;

  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
