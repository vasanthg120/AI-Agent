import { IsString, MinLength } from 'class-validator';

// Anthropic's separate "Admin API key" — see provider-account.schema.ts's
// own adminApiKeyEncrypted comment for why this is distinct from the
// platform apiKey IntegrationCredential already stores.
export class SetAdminApiKeyDto {
  @IsString()
  @MinLength(8)
  adminApiKey: string;
}
