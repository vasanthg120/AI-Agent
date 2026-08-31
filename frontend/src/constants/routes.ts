export const ROUTES = {
  login: '/login',
  register: '/register',
  forgotPassword: '/forgot-password',
  oauthCallback: '/oauth/callback',

  dashboard: '/dashboard',
  agentActivity: '/agent-activity',
  timeline: '/timeline',
  commandCenter: '/command-center',
  dealPerformance: '/deal-performance',
  myCustomerActivity: '/my-customer-activity',
  businessKnowledge: '/business-knowledge',
  emailIntelligence: '/ai-email-inbox',
  finance: '/finance',
  reporting: '/reporting',
  todoEod: '/todo-eod',
  chat: '/chat',
  chatConversation: (id: string) => `/chat/${id}`,
  chatHistory: '/history',
  help: '/help',
  // Kept as its own top-level route (not removed) — backend/src/outlook/
  // outlook.controller.ts's OAuth callback/adminConsentCallback redirect
  // here directly (`/integrations?outlook=<status>`), and IntegrationsPage's
  // own useEffect reads that query param. The real, discoverable entry
  // point is now Settings → Integrations (settingsIntegrations below); this
  // path still works for that redirect and any existing bookmarks.
  integrations: '/integrations',
  billing: '/billing',
  pricing: '/pricing',
  addCredits: '/billing/credits',
  notifications: '/notifications',

  settings: '/settings',
  settingsGeneral: '/settings/general',
  settingsNotifications: '/settings/notifications',
  settingsSecurity: '/settings/security',
  settingsAgentRoles: '/settings/agent-roles',
  settingsUsers: '/settings/users',
  settingsSalesTargets: '/settings/sales-targets',
  settingsDealAssignment: '/settings/deal-assignment',
  settingsRoyaltyRules: '/settings/royalty-rules',
  settingsIntegrations: '/settings/integrations',

  profile: '/profile',

  // Haive-internal only — never added to NAV_GROUPS. Reached by direct URL
  // by a user holding the manually-granted platform_admin role.
  platformAdminBilling: '/platform-admin/billing',
} as const;

// A completely separate admin area — its own sign-in page, its own layout,
// mounted outside AppLayout/ProtectedRoute entirely (see routes/index.tsx).
// Still gated by the same platform_admin role and the same JWT session as
// everything else; see AdminProtectedRoute.tsx.
export const ADMIN_ROUTES = {
  root: '/Admin-haive',
  signin: '/Admin-haive/signin',
  dashboard: '/Admin-haive/dashboard',
  organizations: '/Admin-haive/organizations',
  organizationDetail: (organizationId: string) => `/Admin-haive/organizations/${organizationId}`,
  plans: '/Admin-haive/plans',
  packages: '/Admin-haive/packages',
  features: '/Admin-haive/features',
  entitlements: '/Admin-haive/entitlements',
  prices: '/Admin-haive/prices',
  subscriptions: '/Admin-haive/subscriptions',
  payments: '/Admin-haive/payments',
  paymentSettings: '/Admin-haive/payment-settings',
  wallets: '/Admin-haive/wallets',
  ledger: '/Admin-haive/ledger',
  coupons: '/Admin-haive/coupons',
  refunds: '/Admin-haive/refunds',
  invoices: '/Admin-haive/invoices',
  analytics: '/Admin-haive/analytics',
  adminUsers: '/Admin-haive/admin-users',
  auditLogs: '/Admin-haive/audit-logs',
  settings: '/Admin-haive/settings',
} as const;
