import { IsIn } from 'class-validator';
import { BiFilterQueryDto } from './bi-filter-query.dto';

export class BiEmailsByEmployeeQueryDto extends BiFilterQueryDto {
  @IsIn(['sent', 'missed', 'replied'])
  kind: 'sent' | 'missed' | 'replied';
}
