import { IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyInvitationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;
}

export class AcceptInvitationDto extends VerifyInvitationDto {
  // Same rule as RegisterDto.password.
  @IsString()
  @MinLength(8)
  password: string;
}
