export declare const ASSIGNABLE_ROLES: readonly ["admin", "agent_user", "user", "manager", "consultant"];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export declare class UpdateUserDto {
    role?: AssignableRole;
    assignedAgentId?: string;
    storeId?: string;
    active?: boolean;
    department?: string;
    voiceAccessEnabled?: boolean;
}
