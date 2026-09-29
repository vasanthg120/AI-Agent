import { RoleCategory } from '../schemas/agent-role.schema';
export declare class UpdateAgentRoleDto {
    name?: string;
    department?: RoleCategory;
    description?: string;
    systemPrompt?: string;
    status?: 'draft' | 'active';
    assignedDepartments?: string[];
    assignedUserIds?: string[];
    allowedTools?: string[];
    modelTier?: 'fast' | 'standard' | null;
}
