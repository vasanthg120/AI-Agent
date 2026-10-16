import { IsString, MinLength } from 'class-validator';

// Shared by every platform-wide "bring your own OAuth app" credential pair
// that, unlike Zoho's, has no per-tenant region/data-center concept to also
// collect (Google has one global authority — see gmail.service.ts's own
// comment on why this is simpler than SaveZohoAppCredentialsDto).
export class SaveOAuthAppCredentialsDto {
  @IsString()
  @MinLength(10)
  clientId: string;

  @IsString()
  @MinLength(10)
  clientSecret: string;
}
