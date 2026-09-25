import { IsIn } from 'class-validator';

export class SetOrganizationStatusDto {
  @IsIn(['active', 'suspended'])
  status: 'active' | 'suspended';
}
