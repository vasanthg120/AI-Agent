import { IsString, MinLength } from 'class-validator';

export class SelectOrganizationDto {
  @IsString()
  @MinLength(1)
  organizationId: string;
}
