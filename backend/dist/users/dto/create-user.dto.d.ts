import { AssignableRole } from './update-user.dto';
export declare class CreateUserDto {
    email: string;
    name: string;
    role: AssignableRole;
    assignedAgentId?: string;
    storeId?: string;
    department?: string;
    permissions?: string[];
    active?: boolean;
    sendInvite?: boolean;
    voiceAccessEnabled?: boolean;
    aiAccessEnabled?: boolean;
}
