import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { InvitationsService } from './invitations.service';
import { UsersService } from './users.service';
export declare class UsersController {
    private usersService;
    private invitations;
    constructor(usersService: UsersService, invitations: InvitationsService);
    me(user: JwtPayload): Promise<{
        features: string[] | undefined;
        aiRoleName: string | undefined;
        avatarUrl: string | undefined;
        accountType: string;
        accessMode: import("../common/permissions/account-type").AccessMode;
        aiRole: import("../common/permissions/account-type").AiRoleSummary | null;
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
    updateMe(user: JwtPayload, dto: UpdateProfileDto): Promise<{
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
    aiRoles(caller: JwtPayload): Promise<{
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
    list(caller: JwtPayload): Promise<{
        accountType: string;
        accessMode: import("../common/permissions/account-type").AccessMode;
        aiRole: import("../common/permissions/account-type").AiRoleSummary | null;
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
    create(caller: JwtPayload, dto: CreateUserDto): Promise<{
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
    } | {
        user: {
            pendingInvitation: boolean;
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
            phone: string | undefined;
            timezone: string | undefined;
            language: string | undefined;
            createdAt: Date | undefined;
        };
        activationLink: string | undefined;
        emailSent: boolean;
        emailProblem: string | undefined;
        tempPassword: string | undefined;
    }>;
    resendInvitation(caller: JwtPayload, id: string): Promise<{
        activationLink: string | undefined;
        emailSent: boolean;
        emailProblem: string | undefined;
    }>;
    update(caller: JwtPayload, id: string, dto: UpdateUserDto): Promise<{
        accountType: string;
        accessMode: import("../common/permissions/account-type").AccessMode;
        aiRole: import("../common/permissions/account-type").AiRoleSummary | null;
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
    remove(caller: JwtPayload, id: string): Promise<void>;
}
