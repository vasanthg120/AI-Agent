import { Connection, Types } from 'mongoose';
import { currentDataSourceScope } from './data-source-context';
import { CRM_PROVIDERS, CrmProviderId } from './provider-catalog';

/** The currency a source's amounts are in: what it was set to, else its provider's (Hoops: AUD), else INR. */
export function currencyOf(source: { provider?: string; metadata?: Record<string, unknown> }): string {
  const set = typeof source.metadata?.currency === 'string' ? source.metadata.currency : '';
  return (set || CRM_PROVIDERS[source.provider as CrmProviderId]?.defaultCurrency || 'INR').toUpperCase();
}

/** The currency of the CRM the current request shows (the one chosen for
 * dashboards, through the data-source scope) — what its revenue, targets and
 * reports are in. INR outside a request or for the HaiVE workspace alone. */
export async function scopeCurrency(connection: Connection, organizationId: string): Promise<string> {
  const scope = currentDataSourceScope();
  const id = scope?.organizationId === organizationId ? scope.sourceIds.find((s) => Types.ObjectId.isValid(s)) : undefined;
  if (!id) return 'INR';
  const source = await connection
    .collection('crm_data_sources')
    .findOne({ _id: new Types.ObjectId(id), organizationId }, { projection: { provider: 1, metadata: 1 } });
  return source ? currencyOf(source as { provider?: string; metadata?: Record<string, unknown> }) : 'INR';
}
