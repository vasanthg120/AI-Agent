import { IsOptional, IsString } from 'class-validator';

export class UploadCallRecordingDto {
  @IsOptional() @IsString() dealId?: string;
  @IsOptional() @IsString() contactId?: string;
  @IsString() languageCode: string;
}
