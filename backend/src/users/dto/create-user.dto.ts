import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ASSIGNABLE_ROLES, AssignableRole } from './update-user.dto';

const STORE_SCOPED_ROLES = new Set(['manager', 'consultant']);

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsIn(ASSIGNABLE_ROLES)
  role: AssignableRole;

  @ValidateIf((o: CreateUserDto) => o.role === 'agent_user')
  @IsString()
  assignedAgentId?: string;

  // Required for manager/consultant (store-scoped dashboards) — see
  // update-user.dto.ts's STORE_SCOPED_ROLES comment.
  @ValidateIf((o: CreateUserDto) => STORE_SCOPED_ROLES.has(o.role))
  @IsString()
  @MinLength(1)
  storeId?: string;

  @IsOptional()
  @IsString()
  department?: string;

  // This person's own page & action permissions ("customers:edit", see
  // common/permissions/app-modules.ts) — only with an AI role. Omitted, an AI-role
  // account follows the older rules (its role's features), as before.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions?: string[];

  // Created switched off: the account exists but can't sign in until reactivated.
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  // Email the person a link to set their own password, instead of creating a
  // temporary password for the admin to pass on.
  @IsOptional()
  @IsBoolean()
  sendInvite?: boolean;

  // Optional at creation — schema defaults to true (voice enabled) when
  // omitted. See update-user.dto.ts's identical field for what this gates.
  @IsOptional()
  @IsBoolean()
  voiceAccessEnabled?: boolean;

  // Optional at creation — schema defaults to true (AI enabled) when
  // omitted. See update-user.dto.ts's identical field for what this gates.
  @IsOptional()
  @IsBoolean()
  aiAccessEnabled?: boolean;
}
