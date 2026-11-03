import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsMongoId, IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trimmed = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

const COUNTRY_CODE = /^\+?[1-9]\d{0,3}$/;
const PHONE = /^\d[\d\s-]{5,19}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

// The optional details, the same on both forms. (Only these are shared: class-validator
// merges a parent's rules into a subclass, so a required field can't extend an optional one.)
class SubAccountDetailsDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @trimmed()
  @ValidateIf((_, value) => value !== '')
  @IsUrl({ require_protocol: false }, { message: 'Enter a valid website address.' })
  @MaxLength(200)
  website?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  // PNG, JPEG or WebP as a data URL, already shrunk by the browser. SVG is
  // refused on purpose: it can carry script. '' removes the logo.
  @IsOptional()
  @IsString()
  @Matches(/^$|^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, { message: 'The logo must be a PNG, JPEG or WebP image.' })
  @MaxLength(96_000, { message: 'The logo is too large.' })
  logo?: string;
}

export class CreateSubAccountDto extends SubAccountDetailsDto {
  @trimmed()
  @IsString()
  @MinLength(1, { message: 'Enter the sub-account name.' })
  @MaxLength(120)
  name: string;

  @IsEmail({}, { message: 'Enter a valid business email.' })
  businessEmail: string;

  @trimmed()
  @Matches(COUNTRY_CODE, { message: 'Enter a valid country code, for example +91.' })
  phoneCountryCode: string;

  @trimmed()
  @Matches(PHONE, { message: 'Enter a valid phone number.' })
  phone: string;

  @trimmed()
  @IsString()
  @MinLength(1, { message: 'Choose a time zone.' })
  @MaxLength(60)
  timezone: string;

  @trimmed()
  @Matches(CURRENCY, { message: 'Choose a currency.' })
  currency: string;

  // The person who will own it; the business name is used until they change it.
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  ownerName?: string;

  // Defaults to true: the owner gets a secure link to set their own password.
  @IsOptional()
  @IsBoolean()
  sendInvite?: boolean;
}

// What a Main Account can change later. The owner's email isn't here: it is their
// login, so it isn't this form's to change.
export class UpdateSubAccountDto extends SubAccountDetailsDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @trimmed()
  @Matches(COUNTRY_CODE, { message: 'Enter a valid country code, for example +91.' })
  phoneCountryCode?: string;

  @IsOptional()
  @trimmed()
  @Matches(PHONE, { message: 'Enter a valid phone number.' })
  phone?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @IsOptional()
  @trimmed()
  @Matches(CURRENCY, { message: 'Choose a currency.' })
  currency?: string;
}

export class SetSubAccountStatusDto {
  @IsIn(['active', 'suspended'])
  status: 'active' | 'suspended';
}

export class ArchiveSubAccountDto {
  // Must match the account's name exactly — a deliberate step, not one click.
  @IsString()
  @MinLength(1)
  confirmName: string;
}

export class GrantAccessDto {
  @IsMongoId()
  userId: string;

  @IsIn(['admin', 'manager'])
  role: 'admin' | 'manager';
}

export class SwitchAccountDto {
  @IsMongoId()
  organizationId: string;
}
