import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

// What the Google Drive / OneDrive endpoints take. Ids are the providers' own (opaque
// to HaiVE) and capped in length; names are cleaned again in the service.

const SORTS = ['name', 'modified', 'size'] as const;
const TYPES = ['folder', 'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'video', 'audio', 'archive'] as const;

export class ConnectQueryDto {
  @IsOptional()
  @IsIn(['personal', 'company'])
  ownership?: 'personal' | 'company';
}

export class ListItemsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(600)
  folderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;

  @IsOptional()
  @IsIn(SORTS)
  sort?: (typeof SORTS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';

  @IsOptional()
  @IsIn(TYPES)
  type?: (typeof TYPES)[number];

  @IsOptional()
  @IsIn(['1', 'true'])
  foldersOnly?: string;
}

export class SearchQueryDto {
  @IsString()
  @MaxLength(200)
  q: string;

  @IsOptional()
  @IsIn(TYPES)
  type?: (typeof TYPES)[number];

  @IsOptional()
  @IsDateString()
  modifiedAfter?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  folderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}

export class ItemQueryDto {
  @IsOptional()
  @IsIn(['1', 'true'])
  path?: string;
}

export class ContentQueryDto {
  @IsOptional()
  @IsIn(['1', 'true'])
  inline?: string;
}

export class CreateFolderDto {
  @IsString()
  @MaxLength(600)
  parentId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  parentId?: string;
}

export class FolderGrantDto {
  @IsString()
  @MaxLength(600)
  folderId: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  roles: string[];

  @IsIn(['view', 'edit'])
  access: 'view' | 'edit';
}

export class SetFolderGrantsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FolderGrantDto)
  grants: FolderGrantDto[];
}
