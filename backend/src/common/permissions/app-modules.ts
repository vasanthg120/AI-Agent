import { DEFAULT_ROLE_FEATURES } from '../app-features';

// The parts of HaiVE an admin can open up to one person, page by page and action
// by action. This is the only list: the Users page reads it from
// GET /users/permission-catalog, the server checks every tagged route against it
// (see ModulePermissionInterceptor), and the sidebar uses the same ids.
//
// Who it applies to: people created with an AI role and their own permissions
// (User.permissions is set). Owners and admins have everything; older accounts
// without a permission list keep the rules they had before (fixed role, or the
// AI role's features).

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'manage'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type ModuleGroup = 'workspace' | 'operations' | 'administration';

export interface AppModuleDefinition {
  id: string;
  label: string;
  group: ModuleGroup;
  description: string;
  /** Only the actions that mean something on this page, in display order. */
  actions: readonly PermissionAction[];
  /** What each action lets the person do here — the tooltip next to it. */
  actionHints: Partial<Record<PermissionAction, string>>;
}

export const MODULE_GROUPS: { id: ModuleGroup; label: string }[] = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'operations', label: 'Operations' },
  { id: 'administration', label: 'Administration' },
];

export const APP_MODULES = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    group: 'workspace',
    description: 'The home dashboard and Agent Activity.',
    actions: ['view'],
    actionHints: { view: 'Open the dashboard and Agent Activity.' },
  },
  {
    id: 'analytics',
    label: 'Revenue & Analytics',
    group: 'workspace',
    description: 'Revenue, pipeline, targets, deal performance and business intelligence.',
    actions: ['view', 'export'],
    actionHints: {
      view: 'See revenue, pipeline and the analytics widgets.',
      export: 'Download analytics as files.',
    },
  },
  {
    id: 'ai_agent',
    label: 'AI Agent',
    group: 'workspace',
    description: 'Chat with the AI agent of their AI role, and their chat history.',
    actions: ['view', 'create', 'delete'],
    actionHints: {
      view: 'Open the chat and their own history.',
      create: 'Send messages and start conversations.',
      delete: 'Delete their own conversations.',
    },
  },
  {
    id: 'customers',
    label: 'Customers',
    group: 'workspace',
    description: 'Customers, inquiries, quotes, products and customer activity.',
    actions: ['view', 'create', 'edit', 'delete', 'export'],
    actionHints: {
      view: 'See customers, quotes and their history.',
      create: 'Add customers, notes, tasks and files.',
      edit: 'Change customer details, statuses and quotes.',
      delete: 'Remove customer notes, tasks and files.',
      export: 'Download customer lists and quotes.',
    },
  },
  {
    id: 'job_board',
    label: 'Job Board',
    group: 'workspace',
    description: 'Jobs converted from won deals: statuses, POs, proofs and shipping.',
    actions: ['view', 'create', 'edit', 'delete'],
    actionHints: {
      view: 'See the job board.',
      create: 'Convert deals into jobs.',
      edit: 'Move jobs between statuses and update their details.',
      delete: 'Remove jobs.',
    },
  },
  {
    id: 'email',
    label: 'Email Management',
    group: 'workspace',
    description: 'The AI Email Inbox: their own mailbox, sorted by the AI, with drafted replies.',
    actions: ['view', 'create', 'edit', 'manage'],
    actionHints: {
      view: 'Read their inbox and the AI’s analysis.',
      create: 'Send replies and ask the AI for drafts.',
      edit: 'Change email statuses, dismiss follow-ups and reject drafts.',
      manage: 'Connect and disconnect their mailbox.',
    },
  },
  {
    id: 'call_copilot',
    label: 'Call Copilot',
    group: 'workspace',
    description: 'Live call coaching, call summaries and recordings.',
    actions: ['view', 'create'],
    actionHints: {
      view: 'See their calls, summaries and recordings.',
      create: 'Place calls and start live coaching.',
    },
  },
  {
    id: 'business_knowledge',
    label: 'Business Knowledge',
    group: 'workspace',
    description: 'What the AI knows about the business: profile, documents and advice.',
    actions: ['view', 'create', 'edit', 'delete'],
    actionHints: {
      view: 'Read the business profile and documents.',
      create: 'Upload documents and ask the advisor.',
      edit: 'Change the business profile and documents.',
      delete: 'Remove documents.',
    },
  },
  {
    id: 'files',
    label: 'Files',
    group: 'workspace',
    description: 'Google Drive, OneDrive and shared company folders.',
    actions: ['view', 'create', 'delete'],
    actionHints: {
      view: 'Browse their drives and the folders shared with them.',
      create: 'Connect drives and upload files.',
      delete: 'Disconnect drives and remove files.',
    },
  },
  {
    id: 'reports',
    label: 'Reports',
    group: 'operations',
    description: 'Sales, gross margin and royalty reports.',
    actions: ['view', 'export'],
    actionHints: {
      view: 'Open the reports.',
      export: 'Download reports as PDF, Excel or CSV.',
    },
  },
  {
    id: 'finance',
    label: 'Finance',
    group: 'operations',
    description: 'Finance AI, finance documents, presets and royalty invoices.',
    actions: ['view', 'create', 'edit', 'delete', 'export'],
    actionHints: {
      view: 'See the finance dashboard and documents.',
      create: 'Upload documents, add presets and raise royalty invoices.',
      edit: 'Change documents, presets and invoices.',
      delete: 'Remove documents and presets.',
      export: 'Download finance data.',
    },
  },
  {
    id: 'vendors',
    label: 'Vendor Management',
    group: 'operations',
    description: 'Vendors, vendor quotes and vendor profitability.',
    actions: ['view', 'create', 'edit'],
    actionHints: {
      view: 'See vendors, their quotes and profitability.',
      create: 'Add vendors and vendor quotes.',
      edit: 'Change vendors and vendor quotes.',
    },
  },
  {
    id: 'ai_roles',
    label: 'AI Roles',
    group: 'administration',
    description: 'The AI roles and agents of this workspace.',
    actions: ['view', 'create', 'edit', 'delete', 'manage'],
    actionHints: {
      view: 'See the AI roles.',
      create: 'Create AI roles.',
      edit: 'Change an AI role’s instructions, tools and default access.',
      delete: 'Delete AI roles.',
      manage: 'Activate AI roles or set them back to draft.',
    },
  },
  {
    id: 'users',
    label: 'User Management',
    group: 'administration',
    description: 'People in this workspace. They can only give others access they have themselves.',
    actions: ['view', 'create', 'edit', 'delete'],
    actionHints: {
      view: 'See the people in this workspace.',
      create: 'Add people (never administrators).',
      edit: 'Change people’s details, AI role and access.',
      delete: 'Remove people.',
    },
  },
  {
    id: 'settings',
    label: 'Settings',
    group: 'administration',
    description: 'Workspace settings: general, royalty rules, email SLA, sales targets, deal assignment and statuses.',
    actions: ['view', 'manage'],
    actionHints: {
      view: 'See the workspace settings.',
      manage: 'Change the workspace settings.',
    },
  },
  {
    id: 'integrations',
    label: 'Integrations',
    group: 'administration',
    description: 'Company connections: Microsoft 365 consent, calling numbers, accounting (Xero, MYOB, Zoho Books), Zapier and custom connectors.',
    actions: ['view', 'manage'],
    actionHints: {
      view: 'See what is connected.',
      manage: 'Connect, change and disconnect integrations.',
    },
  },
  {
    id: 'crm_integrations',
    label: 'CRM Integrations',
    group: 'administration',
    description: 'CRM connections (Hoops, Salesforce, Zoho CRM, GorillaDash), data sources, webhooks and syncing.',
    actions: ['view', 'manage'],
    actionHints: {
      view: 'See the connected CRMs and data sources.',
      manage: 'Connect CRMs, run syncs and change data sources.',
    },
  },
] as const satisfies readonly AppModuleDefinition[];

export type AppModuleId = (typeof APP_MODULES)[number]['id'];

const MODULE_BY_ID = new Map<string, AppModuleDefinition>(APP_MODULES.map((m) => [m.id, m]));

export function moduleById(id: string): AppModuleDefinition | undefined {
  return MODULE_BY_ID.get(id);
}

/** "customers:edit" — how one permission is stored on a user or an AI role. */
export function permissionKey(module: string, action: PermissionAction): string {
  return `${module}:${action}`;
}

/** Every permission there is, in catalog order. */
export const ALL_PERMISSIONS: string[] = APP_MODULES.flatMap((m) => m.actions.map((a) => permissionKey(m.id, a)));
const ALL_PERMISSION_SET = new Set(ALL_PERMISSIONS);

export function isKnownPermission(key: string): boolean {
  return ALL_PERMISSION_SET.has(key);
}

/**
 * A permission list as it is saved: only real entries, any action brings the
 * page's `view` with it (you can't edit what you can't open), no duplicates,
 * in catalog order. Turning a page off means sending none of its entries.
 */
export function normalizePermissions(list: readonly string[]): string[] {
  const wanted = new Set(list.filter(isKnownPermission));
  for (const key of [...wanted]) wanted.add(`${key.split(':')[0]}:view`);
  return ALL_PERMISSIONS.filter((key) => wanted.has(key));
}

/** What an HTTP method does, unless the route says otherwise with @Permission(module, action). */
export function actionForMethod(method: string): PermissionAction {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'view';
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'edit';
    case 'DELETE':
      return 'delete';
    default:
      return 'manage';
  }
}

// The basics every person created with an AI role starts from: their dashboard,
// their agent, their files.
const BASICS = ['dashboard:view', 'ai_agent:view', 'ai_agent:create', 'ai_agent:delete', 'files:view', 'files:create', 'files:delete'];

// What each of the older AI-role features meant, in today's terms — used to start
// a new person (or move an older one) from what their AI role already gave.
const FEATURE_PERMISSIONS: Record<string, string[]> = {
  email_inbox: ['email:view', 'email:create', 'email:edit', 'email:delete', 'email:manage'],
  call_copilot: ['call_copilot:view', 'call_copilot:create'],
  inquiries: ['customers:view', 'customers:create', 'customers:edit', 'job_board:view', 'job_board:create', 'job_board:edit'],
  business_knowledge: ['business_knowledge:view'],
};

/** The permissions matching an AI role's older feature list (plus the basics). */
export function permissionsFromFeatures(features: readonly string[]): string[] {
  return normalizePermissions([...BASICS, ...features.flatMap((f) => FEATURE_PERMISSIONS[f] ?? [])]);
}

/** Where a new person on this AI role starts: its own defaults, or what its older features meant. */
export function defaultPermissionsOfRole(role: { defaultPermissions?: readonly string[] | null; features?: readonly string[] | null }): string[] {
  if (Array.isArray(role.defaultPermissions)) return normalizePermissions(role.defaultPermissions);
  return permissionsFromFeatures(Array.isArray(role.features) ? role.features : DEFAULT_ROLE_FEATURES);
}
