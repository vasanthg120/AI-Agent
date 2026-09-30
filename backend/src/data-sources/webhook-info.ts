import type { MirroredModule } from './provider-catalog';
import type { DataSource } from './schemas/data-source.schema';

export const WEBHOOK_PROVIDER = 'zapier';
// Modules a pushed record can be (quotes need line items and a linked deal —
// not something a Zap trigger sends).
export const WEBHOOK_MODULES: MirroredModule[] = ['deals', 'contacts', 'accounts'];

export interface WebhookInfo {
  // Relative to the backend's public address; `baseUrl` is that address when configured.
  paths: Record<string, string>;
  baseUrl: string;
  keyHint?: string;
  lastReceivedAt?: Date;
  received: number;
}

/** Where a webhook source receives records — never its key. */
export function webhookInfo(source: Pick<DataSource, 'modules' | 'metadata'> & { _id: unknown }, baseUrl: string): WebhookInfo {
  const meta = (source.metadata ?? {}) as Record<string, unknown>;
  const id = String(source._id);
  return {
    paths: Object.fromEntries(WEBHOOK_MODULES.filter((m) => (source.modules ?? []).includes(m)).map((m) => [m, `/data-source-webhooks/${id}/${m}`])),
    baseUrl,
    keyHint: typeof meta.webhookKeyHint === 'string' ? meta.webhookKeyHint : undefined,
    lastReceivedAt: meta.webhookLastReceivedAt as Date | undefined,
    received: typeof meta.webhookReceived === 'number' ? meta.webhookReceived : 0,
  };
}
