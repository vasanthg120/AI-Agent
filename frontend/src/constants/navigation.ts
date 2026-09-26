import {
  FiActivity,
  FiBarChart2,
  FiBookOpen,
  FiCheckSquare,
  FiClock,
  FiCreditCard,
  FiDollarSign,
  FiInbox,
  FiMessageSquare,
  FiMic,
  FiPieChart,
  FiSun,
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
      {
        id: 'dashboard',
        label: 'Dashboard',
        path: ROUTES.dashboard,
        icon: FiBarChart2,
        hint: 'Key numbers and trends at a glance',
      },
      {
        id: 'agent-activity',
        label: 'Agent Activity',
        path: ROUTES.agentActivity,
        icon: FiActivity,
        hint: 'What your AI agents are working on',
      },
      {
        id: 'timeline',
        label: 'Timeline',
        path: ROUTES.timeline,
        icon: FiClock,
        hint: "The business's memory — events as they happen",
      },
      {
        id: 'business-knowledge',
        label: 'Business Knowledge',
        path: ROUTES.businessKnowledge,
        icon: FiBookOpen,
        hint: 'What the AI knows about your business',
        // Owner/admin/manager only, matching CRM-dashboard-tier visibility.
        hideForRoles: ['agent_user', 'user', 'consultant'],
      },
      {
        id: 'email-intelligence',
        label: 'AI Email Inbox',
        path: ROUTES.emailIntelligence,
        icon: FiInbox,
        hint: 'AI-sorted inbox and emails waiting on you',
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
        hint: 'Live call coaching, summaries and recordings',
        // Same reasoning as AI Email Inbox above — a live sales-call tool for
        // a real salesperson on the phone, not relevant to an AI-persona account.
        hideForRoles: ['agent_user'],
      },
      {
        id: 'chat-history',
        label: 'History',
        path: ROUTES.chatHistory,
        icon: FiMessageSquare,
        hint: 'Your past conversations with the AI',
      },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        id: 'finance',
        label: 'Finance AI',
        path: ROUTES.finance,
        icon: FiDollarSign,
        hint: 'Vendor payment documents, paid and pending',
        hideForRoles: ['agent_user', 'user', 'manager', 'consultant'],
      },
      {
        id: 'reporting',
        label: 'Reporting',
        path: ROUTES.reporting,
        icon: FiPieChart,
        hint: 'Financial, customer and team performance',
        hideForRoles: ['agent_user', 'user', 'consultant'],
      },
      // Split from one combined "To-Do / EOD" entry into two — EOD now has
      // its own real page (EodPage.tsx) instead of being invisible inside
      // the To-Do board. Kept adjacent in this same group so they still
      // read as connected, not unrelated, features.
      {
        id: 'todo',
        label: 'To-Do',
        path: ROUTES.todoEod,
        icon: FiCheckSquare,
        hint: "Today's tasks, generated before opening",
      },
      { id: 'eod', label: 'EOD Report', path: ROUTES.eod, icon: FiSun, hint: 'End-of-day summary of how the day went' },
      {
        id: 'billing',
        label: 'Billing',
        path: ROUTES.billing,
        icon: FiCreditCard,
        hint: 'Your plan, credits and invoices',
        hideForRoles: ['agent_user'],
      },
    ],
  },
];
