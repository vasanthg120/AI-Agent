// Frames python-agent's /chat/stream sends before its terminal done/error frame.
// The dynamic-agent ones are defined (and already sanitised) in
// python-agent/app/agent/dynamic/stream_events.py; they are rebuilt here from
// the same safe fields, so nothing else can reach a browser through them.

export type AgentActivityType = 'agent_created' | 'agent_progress' | 'validation';

export interface StreamEvent {
  type: 'delta' | 'progress' | 'reasoning' | 'plan' | 'agent_done' | 'reflecting' | AgentActivityType;
  text?: string;
  tool?: string;
  agents?: string[];
  agent?: string;
  reason?: string;
  agent_id?: string;
  status?: string;
  depth?: number;
  attempt?: number;
}

// Existing event types are relayed exactly as received.
const LEGACY_TYPES = new Set(['delta', 'progress', 'reasoning', 'plan', 'agent_done', 'reflecting']);

const ACTIVITY_STATUSES: Record<AgentActivityType, readonly string[]> = {
  agent_created: [],
  agent_progress: ['running', 'retrying', 'failed'],
  validation: ['passed', 'failed'],
};

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;

/** The event to relay for one parsed frame, or null to drop it: an unknown or
 * future type, a malformed frame, or a terminal frame (handled by the caller). */
export function toStreamEvent(frame: unknown): StreamEvent | null {
  if (!frame || typeof frame !== 'object') return null;
  const raw = frame as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== 'string') return null;
  if (LEGACY_TYPES.has(type)) return raw as unknown as StreamEvent;
  if (!Object.prototype.hasOwnProperty.call(ACTIVITY_STATUSES, type)) return null;

  const activity = type as AgentActivityType;
  if (typeof raw.agent !== 'string') return null;
  const event: StreamEvent = { type: activity, agent: raw.agent.slice(0, 80) };
  if (typeof raw.agent_id === 'string' && /^dyn-[0-9a-f]{1,32}$/.test(raw.agent_id)) event.agent_id = raw.agent_id;
  const statuses = ACTIVITY_STATUSES[activity];
  if (statuses.length > 0) {
    if (typeof raw.status !== 'string' || !statuses.includes(raw.status)) return null;
    event.status = raw.status;
  }
  if (activity === 'agent_created' && isCount(raw.depth)) event.depth = raw.depth;
  if (activity === 'agent_progress' && isCount(raw.attempt)) event.attempt = raw.attempt;
  return event;
}
