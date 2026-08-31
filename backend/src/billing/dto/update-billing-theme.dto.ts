import { IsObject, IsOptional, IsString } from 'class-validator';

// `tokens`/`darkTokens` are validated only as plain objects — same
// intentional looseness as WalletTransaction.metadata; the frontend hook
// treats unknown keys as inert extra CSS custom properties, so there's no
// fixed schema to validate against.
export class UpdateBillingThemeDto {
  @IsOptional() @IsObject() tokens?: Record<string, string>;
  @IsOptional() @IsObject() darkTokens?: Record<string, string>;
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @IsString() faviconUrl?: string;
}
