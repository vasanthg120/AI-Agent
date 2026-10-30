import { ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsString, MinLength } from 'class-validator';

export class UpsertDealOwnerMappingDto {
  @IsString()
  @MinLength(1)
  provider: string;

  @IsString()
  @MinLength(1)
  externalOwnerRef: string;

  @IsOptional()
  @IsString()
  externalOwnerLabel?: string;

  // Kept for backward compatibility with the single-user shape this DTO has
  // always had — still accepted on its own. The controller normalizes this
  // and ownerIds below into one array before calling the service; exactly
  // one of the two must be present (enforced in the controller, not here,
  // since class-validator has no clean "exactly one of these two" rule).
  @IsOptional()
  @IsString()
  @MinLength(1)
  ownerId?: string;

  // New: every HaiVE user to link to this external salesperson, for the
  // multi-user case (see DealOwnerMappingService.upsertMapping's own
  // comment). A single-element array behaves identically to the legacy
  // ownerId field.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  ownerIds?: string[];
}
