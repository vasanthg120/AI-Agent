// The parts of HaiVE whose active time Employee Activity measures. The browser
// says which part a page belongs to (frontend hooks/useUsageTracker.ts maps each
// route to one of these); anything else it sends is refused.
export const USAGE_AREAS = ['crm', 'email', 'calls', 'analytics', 'assistant', 'tasks', 'files', 'knowledge', 'admin', 'other'] as const;
export type UsageArea = (typeof USAGE_AREAS)[number];

export const USAGE_AREA_LABELS: Record<UsageArea, string> = {
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

export function isUsageArea(value: unknown): value is UsageArea {
  return typeof value === 'string' && (USAGE_AREAS as readonly string[]).includes(value);
}
