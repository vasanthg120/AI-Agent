import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { ROLE_CATEGORIES, RoleCategory } from '../schemas/agent-role.schema';

export class UpdateAgentRoleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(ROLE_CATEGORIES) department?: RoleCategory;
  @IsOptional() @IsString() description?: string;

  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsIn(['draft', 'active']) status?: 'draft' | 'active';

  @IsOptional() @IsArray() @IsString({ each: true }) assignedDepartments?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) assignedUserIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) allowedTools?: string[];

  // null explicitly clears back to "unset" (see agent-roles.service.ts's
  // update() — a `null` value still passes its `!== undefined` copy check,
  // unlike an omitted field); IsIn's array can include null directly.
  @IsOptional() @IsIn(['fast', 'standard', null]) modelTier?: 'fast' | 'standard' | null;
}
