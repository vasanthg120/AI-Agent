import { IsOptional, IsString } from 'class-validator';

// multipart/form-data body alongside the uploaded CSV file — Step 2 of
// Hoops' own Decoration Import ("Select the vendor... if you don't buy
// these decorations from a 3rd party... you can skip this step").
export class ImportDecorationsDto {
  @IsOptional()
  @IsString()
  vendorId?: string;
}
