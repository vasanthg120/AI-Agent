import { AppFeature } from '../../common/app-features';
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
    features?: AppFeature[];
    modelTier?: 'fast' | 'standard' | null;
}
