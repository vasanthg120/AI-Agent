import { IsOptional, IsString } from 'class-validator';

export class ExcludeSlaRecordDto {
  @IsOptional() @IsString() reason?: string;
}
