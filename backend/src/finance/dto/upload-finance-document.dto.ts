import { IsMongoId, IsOptional } from 'class-validator';

// Multipart fields sent with an uploaded finance document (the file itself
// arrives separately, through FileInterceptor).
export class UploadFinanceDocumentDto {
  // Link the document to this customer quote as it is stored (Finance AI
  // quote costing). Re-checked against the caller's organization.
  @IsOptional()
  @IsMongoId()
  quoteId?: string;
}
