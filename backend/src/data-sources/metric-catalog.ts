import type { CrmModule, FieldMappings, MirroredModule } from './provider-catalog';

// Every business metric HaiVE shows, with what a data source must provide for
// the number to be real. A metric whose requirements a source can't meet is
// reported as "not supported by this CRM" — never computed from another
// source's data and never shown as a misleading zero.

export type MetricSourceKind = 'crm' | 'email';

export interface MetricDefinition {
  id: string;
  label: string;
  kind: MetricSourceKind;
  // CRM metrics: modules and mapped canonical fields ("deals.amount") the
  // source must provide.
  requiresModules?: CrmModule[];
  requiresFields?: string[];
  // Needs the won/lost status mapping to be configured.
  requiresStatus?: boolean;
}

export const METRICS: MetricDefinition[] = [
  {
    id: 'totalDeals',
    label: 'Total deals',
    kind: 'crm',
    requiresModules: ['deals'],
  },
  {
    id: 'convertedDeals',
    label: 'Converted deals',
    kind: 'crm',
    requiresModules: ['deals'],
    requiresStatus: true,
  },
  {
    id: 'activePipeline',
    label: 'Active pipeline',
    kind: 'crm',
    requiresModules: ['deals'],
    requiresFields: ['deals.amount'],
    requiresStatus: true,
  },
  {
    id: 'revenue',
    label: 'Revenue',
    kind: 'crm',
    requiresModules: ['deals'],
    requiresFields: ['deals.amount', 'deals.closeDate'],
    requiresStatus: true,
  },
  {
    id: 'lostDeals',
    label: 'Lost deals',
    kind: 'crm',
    requiresModules: ['deals'],
    requiresStatus: true,
  },
  {
    id: 'teamPerformance',
    label: 'Team performance',
    kind: 'crm',
    requiresModules: ['deals', 'owners'],
    requiresFields: ['deals.owner'],
  },
  { id: 'quotes', label: 'Quotes', kind: 'crm', requiresModules: ['quotes'] },
  {
    id: 'quoteAcceptance',
    label: 'Quote acceptance',
    kind: 'crm',
    requiresModules: ['quotes'],
    requiresFields: ['quotes.approvalStatus'],
  },
  {
    id: 'outstandingDues',
    label: 'Outstanding dues',
    kind: 'crm',
    requiresModules: ['quotes'],
    requiresFields: ['quotes.amount'],
  },
  {
    id: 'customers',
    label: 'Customers',
    kind: 'crm',
    requiresModules: ['deals'],
  },
  {
    id: 'vendorProfitability',
    label: 'Vendor profitability',
    kind: 'crm',
    requiresModules: ['quotes'],
  },
  { id: 'emailsSent', label: 'Emails sent', kind: 'email' },
  { id: 'emailsResponded', label: 'Emails responded', kind: 'email' },
  { id: 'missedEmails', label: 'Missed emails', kind: 'email' },
  { id: 'followUps', label: 'Follow-ups', kind: 'email' },
];

export interface CapabilityInput {
  modules: CrmModule[];
  fieldMappings: FieldMappings;
  statusMapping: { won: string[]; lost: string[] };
  // Native records are already canonical, so every field counts as mapped.
  native: boolean;
}

export type MetricSupport = { supported: true } | { supported: false; reason: string };

/** Whether one CRM source can provide `metric`, and if not, why (in words an
 * administrator can act on). */
export function crmMetricSupport(metric: MetricDefinition, source: CapabilityInput): MetricSupport {
  for (const module of metric.requiresModules ?? []) {
    if (!source.modules.includes(module)) return { supported: false, reason: `This CRM has no ${module}.` };
  }
  if (!source.native) {
    for (const path of metric.requiresFields ?? []) {
      const [module, field] = path.split('.') as [MirroredModule, string];
      if (!source.fieldMappings[module]?.[field]) {
        return {
          supported: false,
          reason: `No field is mapped to ${module} “${field}”.`,
        };
      }
    }
    if (metric.requiresStatus && !source.fieldMappings.deals?.status) {
      return {
        supported: false,
        reason: 'No field is mapped to the deal status.',
      };
    }
  }
  if (metric.requiresStatus && source.statusMapping.won.length === 0 && source.statusMapping.lost.length === 0) {
    return {
      supported: false,
      reason: 'No won/lost status values are configured.',
    };
  }
  return { supported: true };
}
