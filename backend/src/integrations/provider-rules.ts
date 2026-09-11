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
  // Salesforce officially supports OAuth, JWT bearer, and username+password+
  // security-token — never a bare API key. No dedicated OAuth flow is built
  // yet (unlike Outlook/Gmail), so until it is, Bearer (for a JWT you mint
  // externally) is the closest fit already available; API key is refused.
  salesforce: {
    label: 'Salesforce',
    allowedAuthTypes: ['bearer'],
    note: 'Salesforce does not support API keys — OAuth is the recommended method (not yet built as a dedicated flow); Bearer accepts a JWT if you have one.',
  },
  zoho: {
    label: 'Zoho CRM',
    allowedAuthTypes: [],
    note: 'Zoho CRM only supports OAuth — not yet built as a dedicated flow here.',
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
  groq: { label: 'Groq', allowedAuthTypes: ['apiKey'] },
  openai: { label: 'OpenAI', allowedAuthTypes: ['apiKey'] },
  stripe: { label: 'Stripe', allowedAuthTypes: ['apiKey'] },
  twilio: { label: 'Twilio', allowedAuthTypes: ['apiKey'] },
  // White-labeled on purpose: this is the connector id of the external CRM
  // provider used behind the scenes (see python-agent/app/integrations/
  // prospectconnect.py). Customers should only ever see "CRM", never the
  // underlying vendor's name — falling through to getProviderRule's default
  // (label = the raw provider string) would leak it straight into the
  // Custom Integrations list and every toast that names this integration.
  prospectconnect: {
    label: 'CRM',
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
