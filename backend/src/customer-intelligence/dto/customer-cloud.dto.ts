import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { DOCUMENT_CATEGORIES } from '../customer-cloud.service';

// A customer's Google Drive / OneDrive documents. Ids are the providers' own,
// capped in length; the service checks each against the person's access.

export class LinkCustomerFolderDto {
  @IsString()
  @MaxLength(64)
  connectionId: string;

  /** An existing folder to link… */
  @IsOptional()
  @IsString()
  @MaxLength(600)
  folderId?: string;

  /** …or a folder to make inside this one. */
  @IsOptional()
  @IsString()
  @MaxLength(600)
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** With Quotations, Invoices, Contracts, Orders and General Documents inside. */
  @IsOptional()
  @IsBoolean()
  subfolders?: boolean;
}

export class CustomerFolderItemsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(600)
  folderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;

  @IsOptional()
  @IsIn(['name', 'modified', 'size'])
  sort?: 'name' | 'modified' | 'size';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';

  @IsOptional()
  @IsIn(['folder', 'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'video', 'audio', 'archive'])
  type?: 'folder' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'video' | 'audio' | 'archive';
}

export class CustomerFolderSearchQueryDto {
  @IsString()
  @MaxLength(200)
  q: string;

  @IsOptional()
  @IsIn(['folder', 'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'video', 'audio', 'archive'])
  type?: 'folder' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'video' | 'audio' | 'archive';
}

export class CustomerSubfolderDto {
  @IsString()
  @MaxLength(600)
  parentId: string;

  @IsString()
  @MaxLength(200)
  name: string;
}

export class AttachCloudFilesDto {
  @IsString()
  @MaxLength(64)
  connectionId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(600, { each: true })
  fileIds: string[];

  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  quotationId?: string;
}

export class UpdateCloudLinkDto {
  @IsOptional()
  @IsIn(DOCUMENT_CATEGORIES)
  category?: string;

  /** A quotation of this customer, or null to unlink it. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  quotationId?: string | null;
}

export class InlineQueryDto {
  @IsOptional()
  @IsIn(['1', 'true'])
  inline?: string;
}
