import type { UsageArea } from '@/services/teamActivityService';

// The parts of HaiVE whose active time Employee Activity measures (backend
// employee-usage/usage-areas.ts keeps the same list). Each page belongs to one.
const AREA_BY_PREFIX: [string, UsageArea][] = [
  ['/customers', 'crm'],
  ['/inquiries', 'crm'],
  ['/deal-performance', 'crm'],
  ['/my-customer-activity', 'crm'],
  ['/ai-email-inbox', 'email'],
  ['/call-copilot', 'calls'],
  ['/dialer', 'calls'],
  ['/dashboard', 'analytics'],
  ['/reporting', 'analytics'],
  ['/employee-activity', 'analytics'],
  ['/agent-activity', 'analytics'],
  ['/timeline', 'analytics'],
  ['/finance', 'analytics'],
  ['/chat', 'assistant'],
  ['/history', 'assistant'],
  ['/todo-eod', 'tasks'],
  ['/eod', 'tasks'],
  ['/files', 'files'],
  ['/business-knowledge', 'knowledge'],
  ['/settings', 'admin'],
  ['/integrations', 'admin'],
  ['/billing', 'admin'],
  ['/pricing', 'admin'],
  ['/profile', 'admin'],
  ['/notifications', 'admin'],
  ['/help', 'admin'],
];

/** The part of HaiVE a page belongs to. */
export function areaOfPath(pathname: string): UsageArea {
  const match = AREA_BY_PREFIX.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return match ? match[1] : 'other';
}

export const AREA_LABELS: Record<UsageArea, string> = {
  crm: 'CRM & customers',
  email: 'Email inbox',
  calls: 'Call Copilot',
  analytics: 'Dashboards & reports',
  assistant: 'AI assistant',
  tasks: 'Tasks & EOD',
  files: 'Files',
  knowledge: 'Business knowledge',
  admin: 'Settings & admin',
  other: 'Other pages',
};

// Colour follows the part of the app, never its rank: the validated categorical
// slots in their fixed order (checked with the dataviz validator against the white
// surface — adjacent CVD ΔE ≥ 9.1, normal-vision ≥ 19.6). Smaller parts share one
// neutral "Other" so a stack never needs a ninth hue.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'] as const;
export const OTHER_COLOR = '#a8a398';

export type ChartArea = 'crm' | 'email' | 'calls' | 'analytics' | 'assistant' | 'tasks' | 'rest';

/** The stack order of the daily chart: the six named parts in slot order, then everything else. */
export const CHART_AREAS: { key: ChartArea; label: string; color: string }[] = [
  { key: 'crm', label: AREA_LABELS.crm, color: SERIES[0] },
  { key: 'email', label: AREA_LABELS.email, color: SERIES[1] },
  { key: 'calls', label: AREA_LABELS.calls, color: SERIES[2] },
  { key: 'analytics', label: AREA_LABELS.analytics, color: SERIES[3] },
  { key: 'assistant', label: AREA_LABELS.assistant, color: SERIES[4] },
  { key: 'tasks', label: AREA_LABELS.tasks, color: SERIES[5] },
  { key: 'rest', label: 'Other', color: OTHER_COLOR },
];

export function chartAreaOf(area: UsageArea): ChartArea {
  return area === 'files' || area === 'knowledge' || area === 'admin' || area === 'other' ? 'rest' : area;
}

export function areaColor(area: UsageArea): string {
  const key = chartAreaOf(area);
  return CHART_AREAS.find((a) => a.key === key)?.color ?? OTHER_COLOR;
}
