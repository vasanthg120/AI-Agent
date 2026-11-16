import { IsIn, IsString, MinLength } from 'class-validator';

// Same shape as ConnectSquareDto minus applicationId (ListLocations never
// needs it either) — used to validate credentials before committing to
// Connect (see SquareService.testConnection).
export class TestSquareConnectionDto {
  @IsString()
  @MinLength(10)
  accessToken: string;

  @IsIn(['sandbox', 'production'])
  environment: 'sandbox' | 'production';
}
