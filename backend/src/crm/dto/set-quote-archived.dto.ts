import { IsBoolean } from 'class-validator';

export class SetQuoteArchivedDto {
  @IsBoolean()
  archived: boolean;
}
