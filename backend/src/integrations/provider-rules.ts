import { AuthType } from './auth-methods';

/**
 * "Smart provider detection" — a lookup table the Add Integration UI
 * queries (GET /integrations/provider-rules/:name) before showing the
 * auth-method dropdown, so a customer can never pick an auth style a
 * provider doesn't actually support (e.g. an API key for Microsoft/Google/
 * Salesforce, which don't have one). This is deliberately just a rules
 * table, not a plugin system: every provider here still goes through the
 * SAME generic connect/test/status code in integrations.service.ts (for
 * providers whose officially-supported method is one of AuthType) or an
 * existing dedicated OAuth module (Outlook/Gmail — see hasDedicatedFlow
 * below). Adding a new provider is a one-line entry, not new code, which is
 * the actual substance of "provider-driven architecture" here — a real
 * plugin registry/SDK would be justified once there are providers that need
 * genuinely different connection *logic*, not just a different allowed
 * auth-method list.
 */
export interface ProviderRule {
  label: string;
  allowedAuthTypes: AuthType[];
  // Sends the user to an existing, already-built dedicated flow instead of
  // the generic wizard — set only for providers that actually have one.
  dedicatedFlowPath?: string;
  note?: string;
}

export const PROVIDER_RULES: Record<string, ProviderRule> = {
  microsoft: {
    label: 'Microsoft 365 / Outlook',
    allowedAuthTypes: [],
    dedicatedFlowPath: '/outlook',
    note: 'Microsoft requires OAuth — use the Outlook card above, not a custom integration.',
  },
  outlook: {
    label: 'Outlook',
    allowedAuthTypes: [],
    dedicatedFlowPath: '/outlook',
    note: 'Use the Outlook card above — it already handles Microsoft OAuth.',
  },
  google: {
    label: 'Google Workspace / Gmail',
    allowedAuthTypes: [],
    dedicatedFlowPath: '/gmail',
    note: 'Google requires OAuth — use the Gmail card above, not a custom integration.',
  },
  gmail: {
    label: 'Gmail',
    allowedAuthTypes: [],
    dedicatedFlowPath: '/gmail',
    note: 'Use the Gmail card above — it already handles Google OAuth.',
  },
  // Real dedicated OAuth now exists (see ../salesforce/) — connect it from
  // the CRM card on the Integrations page, same as Outlook/Gmail. 'bearer'
  // stays allowed (not removed) as a fallback for a manually-minted JWT,
  // same limitation it always had: no refresh, so it needs re-pasting when
  // it expires. 'oauth2' is never meant to be picked from the generic
  // Custom Integration dropdown — it's reachable only via connectWithOAuth(),
  // called by salesforce.service.ts's own callback, never by a typed form.
  salesforce: {
    label: 'Salesforce',
    allowedAuthTypes: ['bearer', 'oauth2'],
    note: 'Use the Salesforce card in the CRM section above — it handles OAuth with automatic token refresh. Bearer here accepts a manually-minted JWT with no refresh, for advanced/sandbox use only.',
  },
  // Real dedicated OAuth now exists (see ../zoho/) — connect it from the CRM
  // card on the Integrations page. See the Salesforce entry above for why
  // 'oauth2' is listed but not meant for the generic form.
  zoho: {
    label: 'Zoho CRM',
    allowedAuthTypes: ['oauth2'],
    note: 'Use the Zoho CRM card in the CRM section above — it handles OAuth with automatic token refresh.',
  },
  hubspot: {
    label: 'HubSpot',
    allowedAuthTypes: ['bearer'],
    note: 'HubSpot Private App Tokens work with Bearer auth. Full OAuth is not yet built as a dedicated flow.',
  },
  github: {
    label: 'GitHub',
    allowedAuthTypes: ['bearer'],
    note: 'Use a GitHub Personal Access Token with Bearer auth. Full OAuth is not yet built as a dedicated data-access flow (GitHub OAuth for login already exists separately).',
  },
  slack: {
    label: 'Slack',
    allowedAuthTypes: [],
    note: 'Slack only supports OAuth — not yet built as a dedicated flow.',
  },
  anthropic: { label: 'Anthropic', allowedAuthTypes: ['apiKey'] },
  sarvam: { label: 'Sarvam AI', allowedAuthTypes: ['apiKey'] },
  elevenlabs: { label: 'ElevenLabs', allowedAuthTypes: ['apiKey'] },
  // Plivo authenticates with HTTP Basic (Auth ID : Auth Token). Connected from
  // Settings -> Calling, which verifies the pair before saving it.
  plivo: { label: 'Plivo', allowedAuthTypes: ['basic'] },
  groq: { label: 'Groq', allowedAuthTypes: ['apiKey'] },
  // Gorilla Dash authenticates with an API key + secret pair (two headers);
  // stored as basic (key = username, secret = password) by GorillaDashService,
  // which verifies the pair against /api/v1/ping before saving it.
  gorilladash: {
    label: 'Gorilla Dash',
    allowedAuthTypes: ['basic', 'customHeaders'],
  },
  // Zapier MCP: the organization's Zapier MCP server connection token, saved
  // by ZapierService only after Zapier accepted it.
  zapier: { label: 'Zapier', allowedAuthTypes: ['bearer'] },
  openai: { label: 'OpenAI', allowedAuthTypes: ['apiKey'] },
  stripe: { label: 'Stripe', allowedAuthTypes: ['apiKey'] },
  // Twilio authenticates with HTTP Basic (Account SID : Auth Token). Connected
  // from Settings -> Calling (international calls), which verifies the pair first.
  twilio: { label: 'Twilio', allowedAuthTypes: ['basic', 'apiKey'] },
  // Pantheras CRM. "prospectconnect" is its connector id (see python-agent/
  // app/integrations/prospectconnect.py) and "crm" the older name some
  // organizations saved it under — both are shown as Pantheras CRM, never as
  // the raw id.
  crm: { label: 'Pantheras CRM', allowedAuthTypes: ['apiKeyBaseUrl', 'apiKey', 'bearer', 'basic', 'customHeaders'] },
  prospectconnect: {
    label: 'Pantheras CRM',
    allowedAuthTypes: ['apiKeyBaseUrl', 'apiKey', 'bearer', 'basic', 'customHeaders'],
  },
};

/** Unknown providers (anything not in the table — a real "connect ANY REST
 * API" case) get every non-OAuth auth type; that's the generic Custom REST
 * API path, unrestricted by design. */
export function getProviderRule(provider: string): ProviderRule {
  return (
    PROVIDER_RULES[provider.toLowerCase()] ?? {
      label: provider,
      allowedAuthTypes: ['apiKeyBaseUrl', 'apiKey', 'bearer', 'basic', 'customHeaders'],
    }
  );
}
