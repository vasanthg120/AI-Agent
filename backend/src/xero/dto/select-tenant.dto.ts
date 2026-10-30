import { IsString, MinLength } from 'class-validator';

export class SelectTenantDto {
  @IsString()
  @MinLength(1)
  tenantId: string;
}
