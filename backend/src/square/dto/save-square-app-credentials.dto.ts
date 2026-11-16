import { IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

// This organization's OWN Square Developer Console app (see
// square.service.ts's class comment on why this is per-org, not platform-
// wide) — needed only for the OAuth path, never for the Personal Access
// Token path. webhookSecret is optional — see SquareService.saveAppCredentials.
export class SaveSquareAppCredentialsDto {
  @IsString()
  @MinLength(10)
  applicationId: string;

  @IsString()
  @MinLength(10)
  applicationSecret: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  webhookSecret?: string;

  // The EXACT URL this organization registered in its own Square Developer
  // Console's webhook subscription (e.g. https://yourdomain.com/square/
  // webhooks/<this org's id>) — must match byte-for-byte what's signed
  // against, confirmed live: even a trailing-slash difference fails every
  // verification. Never reconstructed from the incoming request (which can
  // differ via proxies/host headers from what Square actually signed).
  @IsOptional()
  @IsUrl({ require_tld: false })
  webhookNotificationUrl?: string;
}
