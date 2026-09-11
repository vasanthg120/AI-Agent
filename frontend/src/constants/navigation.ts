import {
  FiActivity,
  FiBarChart2,
  FiBookOpen,
  FiCheckSquare,
  FiClock,
  FiCreditCard,
  FiDollarSign,
  FiFileText,
  FiInbox,
  FiMessageSquare,
  FiMic,
  FiPieChart,
  FiTerminal,
} from 'react-icons/fi';
import { ROUTES } from './routes';
import type { NavGroup } from '@/types';

// Config-driven sidebar nav — Sidebar/SidebarNav render purely from this
// array, filtering each group's items by hideForRoles. Every group carries
// a label so the sidebar reads consistently top to bottom. "Settings"
// itself lives in the profile dropdown (Sidebar.tsx), not here —
// Integrations/Users & Roles stay reachable via Settings' own internal tab
// nav (SettingsLayout), same as before this nav was redesigned.
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { id: 'dashboard', label: 'Dashboard', path: ROUTES.dashboard, icon: FiBarChart2 },
      { id: 'agent-activity', label: 'Agent Activity', path: ROUTES.agentActivity, icon: FiActivity },
      { id: 'timeline', label: 'Timeline', path: ROUTES.timeline, icon: FiClock },
      {
        id: 'business-knowledge',
        label: 'Business Knowledge',
        path: ROUTES.businessKnowledge,
        icon: FiBookOpen,
        // Owner/admin/manager only, matching CRM-dashboard-tier visibility.
        hideForRoles: ['agent_user', 'user', 'consultant'],
      },
      {
        id: 'email-intelligence',
        label: 'AI Email Inbox',
        path: ROUTES.emailIntelligence,
        icon: FiInbox,
        // Self-scoped to the caller's own connected mailbox — every real role
        // benefits, hidden only for agent_user (an AI-persona account, not a
        // real salesperson mailbox).
        hideForRoles: ['agent_user'],
      },
      {
        id: 'call-copilot',
        label: 'Call Copilot',
        path: ROUTES.callCopilot,
        icon: FiMic,
        // Same reasoning as AI Email Inbox above — a live sales-call tool for
        // a real salesperson on the phone, not relevant to an AI-persona account.
        hideForRoles: ['agent_user'],
      },
      { id: 'chat-history', label: 'History', path: ROUTES.chatHistory, icon: FiMessageSquare },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        id: 'command-center',
        label: 'Command Center',
        path: ROUTES.commandCenter,
        icon: FiTerminal,
        hideForRoles: ['agent_user', 'user', 'manager', 'consultant'],
      },
      {
        id: 'quotes',
        label: 'Quotes',
        path: ROUTES.quotes,
        icon: FiFileText,
        // Read access matches QuotesController's own tier (owner/admin/
        // manager/consultant); only agent_user/user have no reason to see
        // sales quotes.
        hideForRoles: ['agent_user', 'user'],
      },
      {
        id: 'finance',
        label: 'Finance AI',
        path: ROUTES.finance,
        icon: FiDollarSign,
        hideForRoles: ['agent_user', 'user', 'manager', 'consultant'],
      },
      {
        id: 'reporting',
        label: 'Reporting',
        path: ROUTES.reporting,
        icon: FiPieChart,
        hideForRoles: ['agent_user', 'user', 'consultant'],
      },
      { id: 'todo-eod', label: 'To-Do / EOD', path: ROUTES.todoEod, icon: FiCheckSquare },
      {
        id: 'billing',
        label: 'Billing',
        path: ROUTES.billing,
        icon: FiCreditCard,
        hideForRoles: ['agent_user'],
      },
    ],
  },
];
