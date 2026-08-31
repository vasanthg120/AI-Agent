import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout/AppLayout';
import { AuthLayout } from '@/layouts/AuthLayout/AuthLayout';
import { ProtectedRoute, PublicOnlyRoute } from './ProtectedRoute';
import { RequireRole } from './RequireRole';
import { BlockRole } from './BlockRole';
import { Spinner } from '@/components/ui';
import { ROUTES } from '@/constants/routes';

const AdminRoutes = lazy(() => import('@/features/admin-haive/AdminRoutes').then((m) => ({ default: m.AdminRoutes })));

const LoginPage = lazy(() => import('@/features/auth/LoginPage').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('@/features/auth/RegisterPage').then((m) => ({ default: m.RegisterPage })));
const ForgotPasswordPage = lazy(() =>
  import('@/features/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const OAuthCallbackPage = lazy(() =>
  import('@/features/auth/OAuthCallbackPage').then((m) => ({ default: m.OAuthCallbackPage })),
);

const DashboardRouterPage = lazy(() =>
  import('@/features/business-dashboard/DashboardRouterPage').then((m) => ({ default: m.DashboardRouterPage })),
);
const AgentWorkforceDashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const TimelinePage = lazy(() => import('@/features/timeline/TimelinePage').then((m) => ({ default: m.TimelinePage })));
const CommandCenterPage = lazy(() =>
  import('@/features/command-center/CommandCenterPage').then((m) => ({ default: m.CommandCenterPage })),
);
const MyCustomerActivityPage = lazy(() =>
  import('@/features/deal-performance/MyCustomerActivityPage').then((m) => ({ default: m.MyCustomerActivityPage })),
);
const BusinessKnowledgePage = lazy(() =>
  import('@/features/business-knowledge/BusinessKnowledgePage').then((m) => ({ default: m.BusinessKnowledgePage })),
);
const EmailIntelligencePage = lazy(() =>
  import('@/features/email-intelligence/EmailIntelligencePage').then((m) => ({ default: m.EmailIntelligencePage })),
);
const FinancePage = lazy(() => import('@/features/finance/FinancePage').then((m) => ({ default: m.FinancePage })));
const ReportingPage = lazy(() => import('@/features/reporting/ReportingPage').then((m) => ({ default: m.ReportingPage })));
const TodoEodPage = lazy(() => import('@/features/todo-eod/TodoEodPage').then((m) => ({ default: m.TodoEodPage })));
const ChatPage = lazy(() => import('@/features/chat/ChatPage').then((m) => ({ default: m.ChatPage })));
const ChatHistoryPage = lazy(() => import('@/features/chat/ChatHistoryPage').then((m) => ({ default: m.ChatHistoryPage })));
const IntegrationsPage = lazy(() =>
  import('@/features/integrations/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })),
);
const NotificationsPage = lazy(() =>
  import('@/features/notifications/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);
const ProfilePage = lazy(() => import('@/features/profile/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const BillingPage = lazy(() => import('@/features/billing/BillingPage').then((m) => ({ default: m.BillingPage })));
const PricingPage = lazy(() => import('@/features/billing/PricingPage').then((m) => ({ default: m.PricingPage })));
const AddCreditsPage = lazy(() => import('@/features/billing/AddCreditsPage').then((m) => ({ default: m.AddCreditsPage })));
const PlatformAdminBillingPage = lazy(() =>
  import('@/features/platform-admin/PlatformAdminBillingPage').then((m) => ({ default: m.PlatformAdminBillingPage })),
);

const SettingsLayout = lazy(() => import('@/features/settings/SettingsLayout').then((m) => ({ default: m.SettingsLayout })));
const GeneralSettings = lazy(() =>
  import('@/features/settings/tabs/GeneralSettings').then((m) => ({ default: m.GeneralSettings })),
);
const NotificationSettings = lazy(() =>
  import('@/features/settings/tabs/NotificationSettings').then((m) => ({ default: m.NotificationSettings })),
);
const SecuritySettings = lazy(() =>
  import('@/features/settings/tabs/SecuritySettings').then((m) => ({ default: m.SecuritySettings })),
);
const AgentRolesSettings = lazy(() =>
  import('@/features/settings/tabs/AgentRolesSettings').then((m) => ({ default: m.AgentRolesSettings })),
);
const UsersSettings = lazy(() =>
  import('@/features/settings/tabs/UsersSettings').then((m) => ({ default: m.UsersSettings })),
);
const SalesTargetsSettings = lazy(() =>
  import('@/features/settings/tabs/SalesTargetsSettings').then((m) => ({ default: m.SalesTargetsSettings })),
);
const DealAssignmentSettings = lazy(() =>
  import('@/features/settings/tabs/DealAssignmentSettings').then((m) => ({ default: m.DealAssignmentSettings })),
);
const RoyaltyRulesSettings = lazy(() =>
  import('@/features/settings/tabs/RoyaltyRulesSettings').then((m) => ({ default: m.RoyaltyRulesSettings })),
);

const HelpSupportPage = lazy(() => import('@/features/help/HelpSupportPage').then((m) => ({ default: m.HelpSupportPage })));

const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));

function PageFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 240 }}>
      <Spinner size={28} />
    </div>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route element={<PublicOnlyRoute />}>
          <Route
            path={ROUTES.login}
            element={
              <AuthLayout title="Welcome back" subtitle="Sign in to your enterprise AI workspace">
                <LoginPage />
              </AuthLayout>
            }
          />
          <Route
            path={ROUTES.register}
            element={
              <AuthLayout title="Create your workspace" subtitle="Set up your enterprise AI account">
                <RegisterPage />
              </AuthLayout>
            }
          />
          <Route
            path={ROUTES.forgotPassword}
            element={
              <AuthLayout title="Reset your password" subtitle="We'll send a verification code to your email">
                <ForgotPasswordPage />
              </AuthLayout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to={ROUTES.chat} replace />} />
            <Route path={ROUTES.dashboard} element={<DashboardRouterPage />} />
            <Route path={ROUTES.agentActivity} element={<AgentWorkforceDashboardPage />} />
            <Route path={ROUTES.timeline} element={<TimelinePage />} />
            <Route element={<RequireRole role="admin" />}>
              <Route path={ROUTES.commandCenter} element={<CommandCenterPage />} />
            </Route>
            <Route element={<RequireRole role="consultant" />}>
              <Route path={ROUTES.myCustomerActivity} element={<MyCustomerActivityPage />} />
            </Route>
            <Route element={<RequireRole role={['owner', 'admin', 'manager']} />}>
              <Route path={ROUTES.businessKnowledge} element={<BusinessKnowledgePage />} />
            </Route>
            <Route element={<RequireRole role={['owner', 'admin']} />}>
              <Route path={ROUTES.finance} element={<FinancePage />} />
            </Route>
            <Route element={<RequireRole role={['owner', 'admin', 'manager']} />}>
              <Route path={ROUTES.reporting} element={<ReportingPage />} />
            </Route>
            <Route path={ROUTES.todoEod} element={<TodoEodPage />} />
            <Route path={ROUTES.chat} element={<ChatPage />} />
            <Route path={`${ROUTES.chat}/:conversationId`} element={<ChatPage />} />
            <Route path={ROUTES.chatHistory} element={<ChatHistoryPage />} />
            <Route path={ROUTES.notifications} element={<NotificationsPage />} />
            <Route path={ROUTES.profile} element={<ProfilePage />} />
            <Route path={ROUTES.help} element={<HelpSupportPage />} />

            <Route element={<RequireRole role="platform_admin" />}>
              <Route path={ROUTES.platformAdminBilling} element={<PlatformAdminBillingPage />} />
            </Route>

            <Route element={<BlockRole role="agent_user" />}>
              <Route path={ROUTES.emailIntelligence} element={<EmailIntelligencePage />} />
              {/* Legacy/OAuth-callback path — backend/src/outlook/outlook.controller.ts
                  redirects here directly after the Microsoft OAuth round trip
                  (`/integrations?outlook=<status>`), and IntegrationsPage's own
                  useEffect reads that query param. Kept rendering the same page
                  so that flow keeps working; Settings → Integrations below is
                  the discoverable entry point now. */}
              <Route path={ROUTES.integrations} element={<IntegrationsPage />} />
              <Route path={ROUTES.billing} element={<BillingPage />} />
              <Route path={ROUTES.pricing} element={<PricingPage />} />
              <Route path={ROUTES.addCredits} element={<AddCreditsPage />} />
              <Route path={ROUTES.settings} element={<SettingsLayout />}>
                <Route index element={<Navigate to={ROUTES.settingsGeneral} replace />} />
                <Route path="general" element={<GeneralSettings />} />
                <Route path="notifications" element={<NotificationSettings />} />
                <Route path="security" element={<SecuritySettings />} />
                <Route path="agent-roles" element={<AgentRolesSettings />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route element={<RequireRole role="admin" />}>
                  <Route path="users" element={<UsersSettings />} />
                  <Route path="sales-targets" element={<SalesTargetsSettings />} />
                  <Route path="deal-assignment" element={<DealAssignmentSettings />} />
                </Route>
                <Route element={<RequireRole role={['owner', 'admin']} />}>
                  <Route path="royalty-rules" element={<RoyaltyRulesSettings />} />
                </Route>
              </Route>
            </Route>
          </Route>
        </Route>

        {/* Unguarded: reached mid-flow with no session yet — the page
            itself establishes one from the token in the URL. */}
        <Route path={ROUTES.oauthCallback} element={<OAuthCallbackPage />} />

        {/* A completely separate area — its own layout, its own sign-in,
            entirely outside AppLayout/ProtectedRoute above. Must be declared
            before the catch-all so it doesn't fall through to NotFoundPage. */}
        <Route path="/Admin-haive/*" element={<AdminRoutes />} />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
