import { IsIn, IsString, IsUrl, MinLength, ValidateIf } from 'class-validator';
import { ZOHO_DATA_CENTERS } from '../zoho-data-centers';

// 'other' lets an admin paste a raw accounts-server URL for a Zoho data
// center not in the fixed list below (Zoho adds new regions occasionally;
// this never hardcodes "every customer is on one of these N regions").
export class SaveZohoAppCredentialsDto {
  @IsString()
  @MinLength(10)
  clientId: string;

  @IsString()
  @MinLength(10)
  clientSecret: string;

  @IsIn([...Object.keys(ZOHO_DATA_CENTERS), 'other'])
  region: string;

  @ValidateIf((dto: SaveZohoAppCredentialsDto) => dto.region === 'other')
  @IsUrl({ require_tld: true }, { message: 'accountsServerUrl must be a valid https:// URL' })
  accountsServerUrl?: string;
}
