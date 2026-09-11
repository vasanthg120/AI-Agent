import { IsBoolean, IsIn, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

// 'owner' is registration-only (the user who created the org) — not
// assignable via the admin panel, so it's excluded here even though User.roles
// permits it. See user.schema.ts for why this vocabulary is additive rather
// than a replacement of the original admin/agent_user/user set.
export const ASSIGNABLE_ROLES = ['admin', 'agent_user', 'user', 'manager', 'consultant'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

// Manager/Consultant dashboards (Phase 3) are store-scoped — a manager with
// no store can't resolve which store's data to show. Required for both
// roles (not just manager) so store rosters/team lists never have an
// unassigned consultant, even though the Consultant dashboard itself only
// needs userId, not storeId.
const STORE_SCOPED_ROLES = new Set(['manager', 'consultant']);

export class UpdateUserDto {
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES)
  role?: AssignableRole;

  @IsOptional()
  @IsString()
  assignedAgentId?: string;

  @ValidateIf((o: UpdateUserDto) => o.role !== undefined && STORE_SCOPED_ROLES.has(o.role))
  @IsString()
  @MinLength(1)
  storeId?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  department?: string;

  // Provider/model-availability control, not an AI on/off switch — see
  // user.schema.ts's own comment. Only ever gates the voice (Sarvam) route.
  @IsOptional()
  @IsBoolean()
  voiceAccessEnabled?: boolean;
}
