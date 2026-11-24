import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IDENTITY_STATUSES } from '../schemas/external-identity.schema';

export class LinkIdentityDto {
  @IsString()
  @MaxLength(64)
  userId!: string;
}

export class ListIdentitiesQueryDto {
  @IsOptional()
  @IsIn(IDENTITY_STATUSES as unknown as string[])
  status?: (typeof IDENTITY_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  platform?: string;
}

export class SetReportingManagerDto {
  // null / '' clears the manager.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerId?: string | null;
}
