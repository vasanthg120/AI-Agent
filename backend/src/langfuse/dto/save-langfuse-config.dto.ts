import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, Max, Min, MinLength } from 'class-validator';

// Every field optional: saveConfig() does a partial update (see
// langfuse-config.service.ts) so the admin can, for example, change just the
// sampling rate without re-typing the secret key — omitting secretKey keeps
// whatever is already encrypted on file, same "don't accidentally clear an
// existing secret" requirement SaveOAuthAppCredentialsDto's callers already
// satisfy by only sending fields that changed.
export class SaveLangfuseConfigDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  publicKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  secretKey?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['https', 'http'] })
  baseUrl?: string;

  @IsOptional()
  @IsIn(['development', 'staging', 'production'])
  environment?: 'development' | 'staging' | 'production';

  @IsOptional()
  @IsBoolean()
  captureInputOutput?: boolean;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @Min(0)
  @Max(100)
  samplingRate?: number;
}
