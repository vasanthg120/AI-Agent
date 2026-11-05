import { AppFeature } from '../common/app-features';
import { AiRoleSummary } from '../common/permissions/account-type';
import { AppModuleId, PermissionAction } from '../common/permissions/app-modules';
import { Model, Types } from 'mongoose';
import { AgentRoleDocument } from '../agent-roles/schemas/agent-role.schema';
import type { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { PushSubscriptionEntry, SessionEntry, TwoFactorBackupCode, User, UserDocument, UserVoicePreferences } from './schemas/user.schema';
export declare const AI_ROLE_UNAVAILABLE_MESSAGE = "Your AI role isn\u2019t available any more, so there\u2019s no agent to chat with. Ask an admin to give you a new AI role.";
interface AiRoleRecord extends AiRoleSummary {
    features?: string[];
    defaultPermissions?: string[];
    allowedTools: string[];
    builtin: boolean;
}
export declare class UsersService {
    private userModel;
    private agentRoleModel;
    constructor(userModel: Model<UserDocument>, agentRoleModel: Model<AgentRoleDocument>);
    findByEmail(email: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    findById(id: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    emailInUse(email: string): Promise<boolean>;
    resolveSession(payload: Pick<JwtPayload, 'sub' | 'jti' | 'loginUserId'>): Promise<{
        user: UserDocument;
        login: UserDocument;
    } | null>;
    findLinkedMember(loginUserId: string, organizationId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    findLinkedMembersOfLogin(loginUserId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    })[]>;
    createLinkedMember(login: UserDocument, organizationId: string, role: string, storeId?: string): Promise<import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }>;
    removeLinkedMember(loginUserId: string, organizationId: string): Promise<boolean>;
    setInvitation(userId: string, inviteTokenHash: string, inviteExpiresAt: Date): Promise<import("mongoose").UpdateWriteOpResult>;
    findByInvitation(inviteTokenHash: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    consumeInvitation(inviteTokenHash: string, passwordHash: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    organizationName(organizationId: string): Promise<string>;
    findIdsByOrgAndStore(organizationId: string, storeId: string): Promise<string[]>;
    findAll(organizationId: string): Promise<UserDocument[]>;
    findAllWithLinkedMembers(organizationId: string): Promise<UserDocument[]>;
    findTeamRoster(organizationId: string): Promise<UserDocument[]>;
    create(data: {
        email: string;
        passwordHash?: string;
        name: string;
        organizationId: string;
        storeId?: string;
        roles?: string[];
    }): Promise<import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }>;
    findByOAuthId(provider: 'google' | 'microsoft' | 'github', providerId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    linkOAuthProvider(userId: string, provider: 'google' | 'microsoft' | 'github', providerId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    private assertRoleRequirements;
    resolveFeatures(user: {
        roles: string[];
        organizationId: string;
        assignedAgentId?: string;
        permissions?: string[];
    }): Promise<string[] | undefined>;
    profile(userId: string): Promise<{
        features: string[] | undefined;
        aiRoleName: string | undefined;
        avatarUrl: string | undefined;
        accountType: string;
        accessMode: import("../common/permissions/account-type").AccessMode;
        aiRole: AiRoleSummary | null;
        permissions: string[] | null;
        olderPermissions: string[] | null;
        needsAiRole: boolean;
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
        aiAccessEnabled: boolean;
        linkedFromMain: boolean;
        pendingInvitation: boolean;
        phone: string | undefined;
        timezone: string | undefined;
        language: string | undefined;
        createdAt: Date | undefined;
    } | null>;
    private aiRolesOf;
    describeUser(user: UserDocument, aiRoles: Map<string, AiRoleRecord>): {
        accountType: string;
        accessMode: import("../common/permissions/account-type").AccessMode;
        aiRole: AiRoleSummary | null;
        permissions: string[] | null;
        olderPermissions: string[] | null;
        needsAiRole: boolean;
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
        aiAccessEnabled: boolean;
        linkedFromMain: boolean;
        pendingInvitation: boolean;
        phone: string | undefined;
        timezone: string | undefined;
        language: string | undefined;
        createdAt: Date | undefined;
    };
    listDescribed(organizationId: string): Promise<{
        accountType: string;
        accessMode: import("../common/permissions/account-type").AccessMode;
        aiRole: AiRoleSummary | null;
        permissions: string[] | null;
        olderPermissions: string[] | null;
        needsAiRole: boolean;
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
        aiAccessEnabled: boolean;
        linkedFromMain: boolean;
        pendingInvitation: boolean;
        phone: string | undefined;
        timezone: string | undefined;
        language: string | undefined;
        createdAt: Date | undefined;
    }[]>;
    assignableAiRoles(organizationId: string): Promise<{
        slug: string;
        name: string;
        description: string;
        category: string;
        avatarColor: string | undefined;
        allowedTools: string[];
        accountType: string;
        defaultPermissions: string[];
        people: number;
    }[]>;
    permissionCatalog(): {
        groups: {
            id: import("../common/permissions/app-modules").ModuleGroup;
            label: string;
        }[];
        modules: readonly [{
            readonly id: "dashboard";
            readonly label: "Dashboard";
            readonly group: "workspace";
            readonly description: "The home dashboard and Agent Activity.";
            readonly actions: readonly ["view"];
            readonly actionHints: {
                readonly view: "Open the dashboard and Agent Activity.";
            };
        }, {
            readonly id: "analytics";
            readonly label: "Revenue & Analytics";
            readonly group: "workspace";
            readonly description: "Revenue, pipeline, targets, deal performance and business intelligence.";
            readonly actions: readonly ["view", "export"];
            readonly actionHints: {
                readonly view: "See revenue, pipeline and the analytics widgets.";
                readonly export: "Download analytics as files.";
            };
        }, {
            readonly id: "ai_agent";
            readonly label: "AI Agent";
            readonly group: "workspace";
            readonly description: "Chat with the AI agent of their AI role, and their chat history.";
            readonly actions: readonly ["view", "create", "delete"];
            readonly actionHints: {
                readonly view: "Open the chat and their own history.";
                readonly create: "Send messages and start conversations.";
                readonly delete: "Delete their own conversations.";
            };
        }, {
            readonly id: "customers";
            readonly label: "Customers";
            readonly group: "workspace";
            readonly description: "Customers, inquiries, quotes, products and customer activity.";
            readonly actions: readonly ["view", "create", "edit", "delete", "export"];
            readonly actionHints: {
                readonly view: "See customers, quotes and their history.";
                readonly create: "Add customers, notes, tasks and files.";
                readonly edit: "Change customer details, statuses and quotes.";
                readonly delete: "Remove customer notes, tasks and files.";
                readonly export: "Download customer lists and quotes.";
            };
        }, {
            readonly id: "job_board";
            readonly label: "Job Board";
            readonly group: "workspace";
            readonly description: "Jobs converted from won deals: statuses, POs, proofs and shipping.";
            readonly actions: readonly ["view", "create", "edit", "delete"];
            readonly actionHints: {
                readonly view: "See the job board.";
                readonly create: "Convert deals into jobs.";
                readonly edit: "Move jobs between statuses and update their details.";
                readonly delete: "Remove jobs.";
            };
        }, {
            readonly id: "email";
            readonly label: "Email Management";
            readonly group: "workspace";
            readonly description: "The AI Email Inbox: their own mailbox, sorted by the AI, with drafted replies.";
            readonly actions: readonly ["view", "create", "edit", "manage"];
            readonly actionHints: {
                readonly view: "Read their inbox and the AI’s analysis.";
                readonly create: "Send replies and ask the AI for drafts.";
                readonly edit: "Change email statuses, dismiss follow-ups and reject drafts.";
                readonly manage: "Connect and disconnect their mailbox.";
            };
        }, {
            readonly id: "call_copilot";
            readonly label: "Call Copilot";
            readonly group: "workspace";
            readonly description: "Live call coaching, call summaries and recordings.";
            readonly actions: readonly ["view", "create"];
            readonly actionHints: {
                readonly view: "See their calls, summaries and recordings.";
                readonly create: "Place calls and start live coaching.";
            };
        }, {
            readonly id: "business_knowledge";
            readonly label: "Business Knowledge";
            readonly group: "workspace";
            readonly description: "What the AI knows about the business: profile, documents and advice.";
            readonly actions: readonly ["view", "create", "edit", "delete"];
            readonly actionHints: {
                readonly view: "Read the business profile and documents.";
                readonly create: "Upload documents and ask the advisor.";
                readonly edit: "Change the business profile and documents.";
                readonly delete: "Remove documents.";
            };
        }, {
            readonly id: "files";
            readonly label: "Files";
            readonly group: "workspace";
            readonly description: "Google Drive, OneDrive and shared company folders.";
            readonly actions: readonly ["view", "create", "delete"];
            readonly actionHints: {
                readonly view: "Browse their drives and the folders shared with them.";
                readonly create: "Connect drives and upload files.";
                readonly delete: "Disconnect drives and remove files.";
            };
        }, {
            readonly id: "reports";
            readonly label: "Reports";
            readonly group: "operations";
            readonly description: "Sales, gross margin and royalty reports.";
            readonly actions: readonly ["view", "export"];
            readonly actionHints: {
                readonly view: "Open the reports.";
                readonly export: "Download reports as PDF, Excel or CSV.";
            };
        }, {
            readonly id: "finance";
            readonly label: "Finance";
            readonly group: "operations";
            readonly description: "Finance AI, finance documents, presets and royalty invoices.";
            readonly actions: readonly ["view", "create", "edit", "delete", "export"];
            readonly actionHints: {
                readonly view: "See the finance dashboard and documents.";
                readonly create: "Upload documents, add presets and raise royalty invoices.";
                readonly edit: "Change documents, presets and invoices.";
                readonly delete: "Remove documents and presets.";
                readonly export: "Download finance data.";
            };
        }, {
            readonly id: "vendors";
            readonly label: "Vendor Management";
            readonly group: "operations";
            readonly description: "Vendors, vendor quotes and vendor profitability.";
            readonly actions: readonly ["view", "create", "edit"];
            readonly actionHints: {
                readonly view: "See vendors, their quotes and profitability.";
                readonly create: "Add vendors and vendor quotes.";
                readonly edit: "Change vendors and vendor quotes.";
            };
        }, {
            readonly id: "ai_roles";
            readonly label: "AI Roles";
            readonly group: "administration";
            readonly description: "The AI roles and agents of this workspace.";
            readonly actions: readonly ["view", "create", "edit", "delete", "manage"];
            readonly actionHints: {
                readonly view: "See the AI roles.";
                readonly create: "Create AI roles.";
                readonly edit: "Change an AI role’s instructions, tools and default access.";
                readonly delete: "Delete AI roles.";
                readonly manage: "Activate AI roles or set them back to draft.";
            };
        }, {
            readonly id: "users";
            readonly label: "User Management";
            readonly group: "administration";
            readonly description: "People in this workspace. They can only give others access they have themselves.";
            readonly actions: readonly ["view", "create", "edit", "delete"];
            readonly actionHints: {
                readonly view: "See the people in this workspace.";
                readonly create: "Add people (never administrators).";
                readonly edit: "Change people’s details, AI role and access.";
                readonly delete: "Remove people.";
            };
        }, {
            readonly id: "settings";
            readonly label: "Settings";
            readonly group: "administration";
            readonly description: "Workspace settings: general, royalty rules, email SLA, sales targets, deal assignment and statuses.";
            readonly actions: readonly ["view", "manage"];
            readonly actionHints: {
                readonly view: "See the workspace settings.";
                readonly manage: "Change the workspace settings.";
            };
        }, {
            readonly id: "integrations";
            readonly label: "Integrations";
            readonly group: "administration";
            readonly description: "Company connections: Microsoft 365 consent, calling numbers, accounting (Xero, MYOB, Zoho Books), Zapier and custom connectors.";
            readonly actions: readonly ["view", "manage"];
            readonly actionHints: {
                readonly view: "See what is connected.";
                readonly manage: "Connect, change and disconnect integrations.";
            };
        }, {
            readonly id: "crm_integrations";
            readonly label: "CRM Integrations";
            readonly group: "administration";
            readonly description: "CRM connections (Hoops, Salesforce, Zoho CRM, GorillaDash), data sources, webhooks and syncing.";
            readonly actions: readonly ["view", "manage"];
            readonly actionHints: {
                readonly view: "See the connected CRMs and data sources.";
                readonly manage: "Connect CRMs, run syncs and change data sources.";
            };
        }];
        alwaysIncluded: string[];
        notGrantable: string[];
        newRoleDefaults: string[];
    };
    private assertDelegation;
    assertMayManage(caller: JwtPayload, id: string, organizationId: string): Promise<void>;
    aiRoleUnavailable(user: {
        roles?: string[];
        organizationId: string;
        assignedAgentId?: string;
    }): Promise<boolean>;
    socketAccess(payload: Pick<JwtPayload, 'sub' | 'jti' | 'loginUserId'>, module: AppModuleId, action: PermissionAction, olderFeature?: AppFeature): Promise<{
        user: UserDocument | null;
        refusal: string | null;
    }>;
    private avatarOf;
    private permissionsFor;
    createByAdmin(dto: CreateUserDto, organizationId: string, caller?: JwtPayload): Promise<{
        user: {
            id: string;
            email: string;
            name: string;
            organizationId: string;
            storeId: string | undefined;
            roles: string[];
            assignedAgentId: string | undefined;
            department: string | undefined;
            active: boolean;
            voiceAccessEnabled: boolean;
            aiAccessEnabled: boolean;
            linkedFromMain: boolean;
            pendingInvitation: boolean;
            phone: string | undefined;
            timezone: string | undefined;
            language: string | undefined;
            createdAt: Date | undefined;
        };
        tempPassword: string | undefined;
    }>;
    updateByAdmin(id: string, dto: UpdateUserDto, organizationId: string, callerId?: string, caller?: JwtPayload): Promise<{
        accountType: string;
        accessMode: import("../common/permissions/account-type").AccessMode;
        aiRole: AiRoleSummary | null;
        permissions: string[] | null;
        olderPermissions: string[] | null;
        needsAiRole: boolean;
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
        aiAccessEnabled: boolean;
        linkedFromMain: boolean;
        pendingInvitation: boolean;
        phone: string | undefined;
        timezone: string | undefined;
        language: string | undefined;
        createdAt: Date | undefined;
    }>;
    deleteByAdmin(id: string, organizationId: string, caller?: JwtPayload): Promise<void>;
    updateOwnProfile(userId: string, dto: UpdateProfileDto): Promise<{
        avatarUrl: string | undefined;
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
        aiAccessEnabled: boolean;
        linkedFromMain: boolean;
        pendingInvitation: boolean;
        phone: string | undefined;
        timezone: string | undefined;
        language: string | undefined;
        createdAt: Date | undefined;
    }>;
    private assertNotOwner;
    toPublic(user: UserDocument): {
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
        aiAccessEnabled: boolean;
        linkedFromMain: boolean;
        pendingInvitation: boolean;
        phone: string | undefined;
        timezone: string | undefined;
        language: string | undefined;
        createdAt: Date | undefined;
    };
    setVerifyOtp(userId: string, otpHash: string, expiresAt: Date): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    markEmailVerified(userId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    setResetOtp(userId: string, otpHash: string, expiresAt: Date): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    resetPassword(userId: string, passwordHash: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    addSession(userId: string, entry: SessionEntry): Promise<void>;
    touchSessionIfStale(userId: string, jti: string): Promise<unknown>;
    revokeSession(userId: string, jti: string): Promise<import("mongoose").UpdateWriteOpResult>;
    revokeAllOtherSessions(userId: string, keepJti: string): Promise<string[]>;
    addOrReplacePushSubscription(userId: string, entry: PushSubscriptionEntry): Promise<void>;
    removePushSubscription(userId: string, endpoint: string): Promise<import("mongoose").UpdateWriteOpResult>;
    updateNotificationPreferences(userId: string, patch: Partial<{
        desktopPush: boolean;
        mobilePush: boolean;
        email: boolean;
    }>): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    getVoicePreferences(userId: string): Promise<UserVoicePreferences>;
    updateVoicePreferences(userId: string, patch: {
        voiceId?: string | null;
        personality?: string | null;
    }): Promise<UserVoicePreferences>;
    setPendingTwoFactorSecret(userId: string, secretEncrypted: string, expiresAt: Date): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    confirmTwoFactor(userId: string, secretEncrypted: string, backupCodes: TwoFactorBackupCode[]): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    clearTwoFactor(userId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    setBackupCodes(userId: string, backupCodes: TwoFactorBackupCode[]): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    markBackupCodeUsed(userId: string, codeHash: string): Promise<import("mongoose").UpdateWriteOpResult>;
    private resolveValidAgentIds;
}
export {};
