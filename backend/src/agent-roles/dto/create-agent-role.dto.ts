import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { ROLE_CATEGORIES, RoleCategory } from '../schemas/agent-role.schema';

// Agent Builder redesign — Manual and Template creation both post here
// (Template just pre-fills these fields client-side from a constant, no
// server-side concept of "template" exists). No file, no AI call — the
// admin writes everything directly, matching Describe/Documents' own
// review-before-save step but skipping generation entirely. organizationId/
// createdBy/slug/status/sourceDocument* are all server-derived, never
// client-supplied — same convention generateDraft() already follows.
export class CreateAgentRoleDto {
  @IsString() name: string;

  @IsOptional() @IsIn(ROLE_CATEGORIES) department?: RoleCategory;
  @IsOptional() @IsString() description?: string;

  @IsString() systemPrompt: string;

  @IsOptional() @IsArray() @IsString({ each: true }) assignedDepartments?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) assignedUserIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) allowedTools?: string[];

  @IsOptional() @IsIn(['fast', 'standard', null]) modelTier?: 'fast' | 'standard' | null;
}
