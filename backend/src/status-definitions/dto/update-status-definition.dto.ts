import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateStatusDefinitionDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;
}
