// Groups the same 18 real python-agent tool identifiers TOOL_PICKER_OPTIONS
// (frontend/src/features/chat/toolPickerOptions.ts) already lists — by
// system, for the Access & Permissions / Tools & Capabilities steps. Not a
// second source of truth: every `name` here is one of those exact ids,
// enforced by tests/manual cross-check, not duplicated logic. `remember` is
// deliberately excluded — it gets its own dedicated toggle in the Memory
// step instead of appearing twice.
export interface ToolCatalogItem {
  name: string;
  label: string;
  // Send/write-type actions — off by default in ROLE_CATEGORY_PRESETS,
  // called out explicitly in the Security & Guardrails step's recap.
  sensitive?: boolean;
  // Which org-level connection this depends on, if any — used by the
  // Access step to show real connection status (undefined = always
  // available, no external account required).
  provider?: 'outlook' | 'gmail' | 'crm';
}

export interface ToolSystem {
  id: string;
  label: string;
  description: string;
  tools: ToolCatalogItem[];
}

export const TOOL_SYSTEMS: ToolSystem[] = [
  {
    id: 'email',
    label: 'Email',
    description: 'Read mail from a connected mailbox, and send replies on the agent’s behalf.',
    tools: [
      { name: 'outlook_lookup', label: 'Read Outlook mail & contacts', provider: 'outlook' },
      { name: 'gmail_lookup', label: 'Read Gmail mail & contacts', provider: 'gmail' },
      { name: 'send_email', label: 'Send emails', sensitive: true },
    ],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    description: 'Send messages through connected messaging channels.',
    tools: [{ name: 'send_whatsapp_message', label: 'Send WhatsApp messages', sensitive: true }],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'View and schedule events on the connected Outlook calendar.',
    tools: [{ name: 'calendar_tool', label: 'View & schedule calendar events', provider: 'outlook' }],
  },
  {
    id: 'crm',
    label: 'CRM',
    description: 'Look up and reference customer, deal, and sales records.',
    tools: [
      { name: 'crm_contact', label: 'Contacts', provider: 'crm' },
      { name: 'crm_deal', label: 'Deals', provider: 'crm' },
      { name: 'crm_quote', label: 'Quotes', provider: 'crm' },
      { name: 'crm_account', label: 'Accounts', provider: 'crm' },
      { name: 'crm_product', label: 'Products', provider: 'crm' },
      { name: 'crm_note', label: 'Notes', provider: 'crm' },
      { name: 'crm_tag', label: 'Tags', provider: 'crm' },
    ],
  },
  {
    id: 'knowledge',
    label: 'Documents & Knowledge',
    description: 'Search uploaded documents and your organization’s shared knowledge base.',
    tools: [
      { name: 'search_documents', label: 'Search uploaded documents' },
      { name: 'search_business_context', label: 'Search business knowledge, CRM & mail context' },
      { name: 'query_database', label: 'Look up saved notes & preferences' },
    ],
  },
  {
    id: 'web',
    label: 'Web Search',
    description: 'Search the public internet for information not in your own knowledge base.',
    tools: [{ name: 'web_search', label: 'Search the web' }],
  },
  {
    id: 'directory',
    label: 'Employee Directory',
    description: 'Look up people in your organization.',
    tools: [{ name: 'employee_lookup', label: 'Look up employees' }],
  },
];

export const MEMORY_TOOL = 'remember';

export function isSensitiveTool(name: string): boolean {
  return TOOL_SYSTEMS.some((system) => system.tools.some((t) => t.name === name && t.sensitive));
}

export function isSystemEnabled(system: ToolSystem, allowedTools: string[]): boolean {
  return system.tools.some((t) => allowedTools.includes(t.name));
}

// Toggling a system on grants its non-sensitive (view/search) tools by
// default — sensitive ones (send/write) stay an explicit opt-in in the
// Tools & Capabilities step, never auto-granted.
export function defaultToolsForSystem(system: ToolSystem): string[] {
  return system.tools.filter((t) => !t.sensitive).map((t) => t.name);
}

export function toolLabel(name: string): string {
  for (const system of TOOL_SYSTEMS) {
    const tool = system.tools.find((t) => t.name === name);
    if (tool) return tool.label;
  }
  return name === MEMORY_TOOL ? 'Remember important details' : name;
}
