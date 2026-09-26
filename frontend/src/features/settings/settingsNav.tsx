import type { ReactNode } from 'react';
import {
  FiSettings,
  FiBell,
  FiVolume2,
  FiPhoneCall,
  FiShield,
  FiUsers,
  FiUserPlus,
  FiTarget,
  FiUserCheck,
  FiPercent,
  FiLink2,
  FiClock,
} from 'react-icons/fi';
import { ROUTES } from '@/constants/routes';

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  path: string;
  /** One-liner under the label in the sidebar. */
  hint: string;
  /** Longer sentence shown in the page header once the tab is open. */
  summary: string;
  /** Extra search terms — what someone might type when they don't know the tab's name. */
  keywords?: string[];
  requireRoles?: string[];
}

export interface SettingsNavGroup {
  id: string;
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    id: 'preferences',
    label: 'Preferences',
    items: [
      {
        id: 'general',
        label: 'General',
        icon: <FiSettings />,
        path: ROUTES.settingsGeneral,
        hint: 'Store hours & timezone',
        summary: 'Opening hours and timezone that HaiVE AI uses for daily to-do lists and end-of-day reports.',
        keywords: ['timezone', 'hours', 'opening', 'closing', 'store', 'timing'],
      },
      {
        id: 'notifications',
        label: 'Notifications',
        icon: <FiBell />,
        path: ROUTES.settingsNotifications,
        hint: 'Push & email alerts',
        summary: 'Choose where you get alerted — this browser, your phone, or your inbox.',
        keywords: ['push', 'email', 'alerts', 'desktop', 'mobile'],
      },
      // How the AI Call Copilot (and every feature that speaks) sounds — open to
      // everyone; the organization-defaults card inside is owner/admin only.
      {
        id: 'voice',
        label: 'Voice & Accent',
        icon: <FiVolume2 />,
        path: ROUTES.settingsVoice,
        hint: 'How the AI sounds',
        summary: 'Pick the voice and accent the AI uses whenever it speaks — preview any voice before you choose it.',
        keywords: ['tts', 'speech', 'accent', 'audio', 'elevenlabs'],
      },
      {
        id: 'security',
        label: 'Security',
        icon: <FiShield />,
        path: ROUTES.settingsSecurity,
        hint: 'Password, 2FA & sessions',
        summary: 'Protect your account with a strong password, two-factor authentication and session control.',
        keywords: ['password', '2fa', 'two-factor', 'sessions', 'api', 'token'],
      },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      {
        id: 'agent-roles',
        label: 'AI Roles',
        icon: <FiUsers />,
        path: ROUTES.settingsAgentRoles,
        hint: 'AI agents & personas',
        summary: 'Create and tune the AI agents your team works with, and what each one is responsible for.',
        keywords: ['agents', 'persona', 'assistant', 'roles'],
      },
      // Moved out of the main sidebar nav (was its own top-level page) — same
      // visibility as the tabs above (open to everyone except agent_user, via
      // the shared BlockRole wrapping the whole /settings subtree in
      // routes/index.tsx), no additional requireRoles needed.
      {
        id: 'integrations',
        label: 'Integrations',
        icon: <FiLink2 />,
        path: ROUTES.settingsIntegrations,
        hint: 'Connected apps & data',
        summary: 'Connect the tools your business already runs on so the AI can work with real data.',
        keywords: ['outlook', 'crm', 'connect', 'apps', 'oauth'],
      },
      // Record phone calls through Plivo into Call Library — connecting the account
      // and linking numbers to people is an owner/admin job; everyone else just
      // places calls from Call Copilot.
      {
        id: 'calling',
        label: 'Calling',
        icon: <FiPhoneCall />,
        path: ROUTES.settingsCalling,
        hint: 'Phone numbers & recording',
        summary: 'Connect Plivo, link each phone number to a person, and send recorded calls to Call Copilot.',
        keywords: ['plivo', 'phone', 'numbers', 'recording', 'calls'],
        requireRoles: ['owner', 'admin'],
      },
    ],
  },
  {
    id: 'team',
    label: 'Team & Sales',
    items: [
      {
        id: 'users',
        label: 'Users',
        icon: <FiUserPlus />,
        path: ROUTES.settingsUsers,
        hint: 'Invite & manage people',
        summary: 'Add teammates, change their roles, and remove access when someone leaves.',
        keywords: ['team', 'members', 'invite', 'roles', 'staff'],
        requireRoles: ['admin'],
      },
      {
        id: 'sales-targets',
        label: 'Sales Targets',
        icon: <FiTarget />,
        path: ROUTES.settingsSalesTargets,
        hint: 'Store & employee goals',
        summary: 'Set monthly sales goals for the store and for each employee.',
        keywords: ['goals', 'quota', 'targets', 'revenue'],
        requireRoles: ['admin'],
      },
      {
        id: 'deal-assignment',
        label: 'Deal Assignment',
        icon: <FiUserCheck />,
        path: ROUTES.settingsDealAssignment,
        hint: 'Who owns each deal',
        summary: 'Give every deal an owner so its revenue counts for the right person — one at a time, in bulk, or by linking CRM owners.',
        keywords: ['owner', 'assign', 'crm', 'leads', 'deals', 'mapping'],
        requireRoles: ['admin'],
      },
    ],
  },
  {
    id: 'policies',
    label: 'Rules & Policies',
    items: [
      // Widened to ['owner','admin'] — matches RoyaltyRulesController's actual
      // backend gate, unlike the Team tabs above (['admin']-only), since this
      // is sensitive org-wide financial configuration.
      {
        id: 'royalty-rules',
        label: 'Royalty Rules',
        icon: <FiPercent />,
        path: ROUTES.settingsRoyaltyRules,
        hint: 'Commission percentages',
        summary: 'Define royalty and commission percentages, with a full history of every change.',
        keywords: ['commission', 'royalty', 'percent', 'payout'],
        requireRoles: ['owner', 'admin'],
      },
      // Matches EmailSlaController's mutation gate (owner/admin) — the
      // read-only policy list route allows manager too, but this tab is
      // primarily for configuring policy, so it stays owner/admin only.
      {
        id: 'email-sla',
        label: 'Email SLA',
        icon: <FiClock />,
        path: ROUTES.settingsEmailSla,
        hint: 'Reply-time policies',
        summary: 'How fast each priority of email must get a reply, when the clock runs, and who is notified when a deadline is missed.',
        keywords: ['sla', 'response', 'escalation', 'reply', 'inbox'],
        requireRoles: ['owner', 'admin'],
      },
    ],
  },
];
