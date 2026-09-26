import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const PROFILE_LANGUAGES = ['en-US', 'en-GB', 'en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN'] as const;

// What any signed-in user may change about themselves (PATCH /users/me).
// Deliberately excludes role/store/active/email — those stay admin-only via
// UpdateUserDto, so this route can never be used to escalate privileges.
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  // Loose on purpose (people type spaces, dashes, brackets, a leading +);
  // an empty string clears the number.
  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^$|^\+?[0-9 ()-]{5,}$/, { message: 'phone must contain only digits, spaces, (), - and an optional leading +' })
  phone?: string;

  // IANA zone name, e.g. "Asia/Kolkata" — validated server-side in the service
  // with Intl, since class-validator has no timezone check.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsIn(PROFILE_LANGUAGES)
  language?: string;
}
