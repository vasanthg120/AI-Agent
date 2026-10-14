import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId, IsOptional, IsString } from 'class-validator';

export class AssignDealDto {
  // Explicit null unassigns; omitting the field is not a valid call for this
  // endpoint (the frontend always sends one or the other).
  @IsOptional()
  @IsString()
  ownerId?: string | null;
}

// Many deals to one person (or to nobody) in a single request.
export class AssignDealsBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsMongoId({ each: true })
  dealIds: string[];

  // Explicit null unassigns them.
  @IsOptional()
  @IsString()
  ownerId?: string | null;
}
