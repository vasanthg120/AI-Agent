// Friendly labels for the specialist keys the backend's 'plan' event names
// (python-agent's app/agent/specialists.py) — same style as toolLabels.ts's
// TOOL_LABELS, kept as a separate map since these are specialist agents, not
// individual tool calls.
export const AGENT_LABELS: Record<string, string> = {
  crm: 'Searching CRM',
  outlook: 'Reading Outlook',
  calendar: 'Checking the calendar',
  knowledge: 'Searching the knowledge base',
  operations: 'Checking store records',
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? `Checking ${agent}`;
}

/** Status line for a dynamic sub-agent's lifecycle update, or null when it
 * shouldn't change what's shown (created, validation, anything unrecognised).
 * The payload comes off the socket, so nothing about it is assumed. */
export function agentActivityStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const { type, status, agent } = payload as Record<string, unknown>;
  if (type !== 'agent_progress' || typeof agent !== 'string' || !agent) return null;
  if (status === 'running') return `Working on ${agent}…`;
  if (status === 'retrying') return `Retrying ${agent}…`;
  if (status === 'failed') return `Couldn't finish ${agent}, continuing…`;
  return null;
}

export function planStatus(agents: string[]): string {
  if (agents.length === 0) return 'Planning…';
  return `${agents.map(agentLabel).join(', ')}…`;
}
