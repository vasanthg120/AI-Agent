// Short display names for the "Allowed Tools" picker in AgentRolesSettings.tsx
// — a different job from toolLabels.ts's progress-toast sentences ("Looking
// up contact details…"), so deliberately not reused from there. Keys must
// match python-agent's tool SPEC["name"] values exactly (app/tools/*.py) —
// grepped, not guessed.
export const TOOL_PICKER_OPTIONS: { name: string; label: string }[] = [
  { name: 'crm_contact', label: 'CRM Contacts' },
  { name: 'crm_deal', label: 'CRM Deals' },
  { name: 'crm_note', label: 'CRM Notes' },
  { name: 'crm_tag', label: 'CRM Tags' },
  { name: 'crm_account', label: 'CRM Accounts' },
  { name: 'crm_product', label: 'CRM Products' },
  { name: 'crm_quote', label: 'CRM Quotes' },
  { name: 'crm_source_records', label: 'CRM records by data source' },
  { name: 'zapier', label: 'Zapier apps (Hoops, …)' },
  { name: 'gorilladash_lookup', label: 'Gorilla Dash (read)' },
  { name: 'gorilladash_action', label: 'Gorilla Dash (create / update leads, email)' },
  { name: 'outlook_lookup', label: 'Outlook' },
  { name: 'gmail_lookup', label: 'Gmail' },
  { name: 'send_whatsapp_message', label: 'Send WhatsApp' },
  { name: 'calendar_tool', label: 'Calendar' },
  { name: 'employee_lookup', label: 'Employee Directory' },
  { name: 'query_database', label: 'Database Query' },
  { name: 'web_search', label: 'Web Search' },
  { name: 'send_email', label: 'Send Email' },
  { name: 'search_documents', label: 'Document Search' },
  { name: 'search_business_context', label: 'Business Context Search' },
  { name: 'remember', label: 'Memory' },
];
