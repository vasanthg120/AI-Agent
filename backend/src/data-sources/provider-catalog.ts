import type { SyncWindow } from './sync-window';

// What HaiVE knows about each kind of CRM it can take data from — the only
// place a provider's own vocabulary (object names, field names, the words it
// uses for a won or lost deal) lives. Everything downstream (dashboards,
// reports, AI tools) works on HaiVE's own canonical model and never sees a
// provider's field names; a new CRM is one entry here plus a sync adapter
// (python-agent/app/integrations/crm_adapters.py), with no dashboard changes.
//
// Every value below is a *default*. Each connected data source carries its own
// copy (DataSource.fieldMappings / statusMapping / terminology / modules),
// which an administrator can change in Settings → Data Sources — so a CRM that
// calls its deals "Sales Cases" or stores the amount in a custom field is a
// configuration change, not a code change.

export type CrmModule = 'deals' | 'quotes' | 'contacts' | 'accounts' | 'pipelines' | 'owners' | 'notes' | 'tags' | 'products';

export const CRM_MODULES: CrmModule[] = ['deals', 'quotes', 'contacts', 'accounts', 'pipelines', 'owners', 'notes', 'tags', 'products'];

// The modules whose records HaiVE mirrors into its own collections. The rest
// (notes, tags, products, pipelines, owners) are capability flags only.
export type MirroredModule = 'deals' | 'quotes' | 'contacts' | 'accounts';

export interface CanonicalField {
  key: string;
  label: string;
  hint: string;
}

// HaiVE's own data model: the fields a provider's records are mapped onto.
export const CANONICAL_FIELDS: Record<MirroredModule, CanonicalField[]> = {
  deals: [
    {
      key: 'externalId',
      label: 'Record ID',
      hint: 'Unique id of the record in the CRM.',
    },
    { key: 'name', label: 'Name', hint: 'What the deal is called.' },
    { key: 'amount', label: 'Value', hint: 'The deal’s monetary value.' },
    {
      key: 'status',
      label: 'Status',
      hint: 'Open, won or lost — mapped with the status values below.',
    },
    {
      key: 'stage',
      label: 'Pipeline stage',
      hint: 'Where the deal sits in its pipeline.',
    },
    {
      key: 'pipeline',
      label: 'Pipeline',
      hint: 'Which pipeline the deal belongs to.',
    },
    {
      key: 'closeDate',
      label: 'Close date',
      hint: 'Expected or actual closing date.',
    },
    { key: 'owner', label: 'Owner', hint: 'The CRM user who owns the deal.' },
    {
      key: 'createdAt',
      label: 'Created',
      hint: 'When the deal was created in the CRM.',
    },
  ],
  quotes: [
    {
      key: 'externalId',
      label: 'Record ID',
      hint: 'Unique id of the quote in the CRM.',
    },
    { key: 'name', label: 'Name', hint: 'What the quote is called.' },
    { key: 'amount', label: 'Amount', hint: 'Total quoted amount.' },
    { key: 'status', label: 'Status', hint: 'Draft, sent, …' },
    {
      key: 'approvalStatus',
      label: 'Customer approval',
      hint: 'Whether the customer accepted it.',
    },
    { key: 'currency', label: 'Currency', hint: 'Currency code.' },
    {
      key: 'number',
      label: 'Quote number',
      hint: 'Human-readable quote number.',
    },
    {
      key: 'dealRef',
      label: 'Linked deal',
      hint: 'Id of the deal this quote belongs to.',
    },
    { key: 'owner', label: 'Owner', hint: 'The CRM user who owns the quote.' },
    {
      key: 'ownerName',
      label: 'Owner name',
      hint: 'That user’s name, when the CRM sends it.',
    },
    {
      key: 'customerCompany',
      label: 'Customer company',
      hint: 'Customer’s company name.',
    },
    {
      key: 'customerName',
      label: 'Customer contact',
      hint: 'Customer contact’s name.',
    },
    {
      key: 'customerEmail',
      label: 'Customer email',
      hint: 'Customer’s email address.',
    },
    {
      key: 'customerPhone',
      label: 'Customer phone',
      hint: 'Customer’s phone number.',
    },
    {
      key: 'expirationDate',
      label: 'Valid until',
      hint: 'When the quote expires.',
    },
    { key: 'createdAt', label: 'Created', hint: 'When the quote was created.' },
  ],
  contacts: [
    {
      key: 'externalId',
      label: 'Record ID',
      hint: 'Unique id of the contact in the CRM.',
    },
    { key: 'name', label: 'Name', hint: 'Full name.' },
    { key: 'email', label: 'Email', hint: 'Email address.' },
    { key: 'phone', label: 'Phone', hint: 'Phone number.' },
    {
      key: 'company',
      label: 'Company',
      hint: 'Company the contact works for.',
    },
    { key: 'createdAt', label: 'Created', hint: 'When the contact was created in the CRM.' },
  ],
  accounts: [
    {
      key: 'externalId',
      label: 'Record ID',
      hint: 'Unique id of the company/account in the CRM.',
    },
    { key: 'name', label: 'Name', hint: 'Company name.' },
    {
      key: 'domain',
      label: 'Website/domain',
      hint: 'Company website or email domain.',
    },
  ],
};

export type FieldMappings = Partial<Record<MirroredModule, Record<string, string>>>;

export interface StatusMapping {
  // Raw status/stage values (case-insensitive) that mean the deal was won / lost;
  // everything else is open.
  won: string[];
  lost: string[];
}

export interface Terminology {
  deal: string;
  quote: string;
  contact: string;
  account: string;
}

export type CrmProviderId = 'haive_native' | 'prospectconnect' | 'hubspot' | 'salesforce' | 'zoho' | 'gorilladash' | 'hoops' | 'zapier' | 'custom';

// How a provider's records reach HaiVE: pulled by the sync through its API
// adapter, pushed to a HaiVE webhook by the provider (or an automation in
// front of it), or neither (HaiVE's own records).
export type CrmConnection = 'pull' | 'push' | 'none';

export interface CrmProviderDefinition {
  id: CrmProviderId;
  // Shown to customers.
  label: string;
  description: string;
  // integration_credentials.provider values that mean "this CRM is connected".
  integrationProviders: string[];
  modules: CrmModule[];
  terminology: Terminology;
  fieldMappings: FieldMappings;
  statusMapping: StatusMapping;
  // Whether HaiVE can pull this provider's records into its dashboards.
  syncSupported: boolean;
  // Defaults to 'pull' when syncSupported, otherwise 'none'.
  connection?: CrmConnection;
  // How often a new source of this provider is read. Absent: every 10 minutes.
  // A window (Hoops) limits reading to once a night inside it — see sync-window.ts.
  syncDefaults?: { intervalMinutes: number; window?: SyncWindow };
  // The currency its amounts are in when the CRM doesn't say (Hoops sends none; it is Australian). Absent: INR.
  defaultCurrency?: string;
}

const DEFAULT_TERMS: Terminology = {
  deal: 'Deal',
  quote: 'Quote',
  contact: 'Contact',
  account: 'Account',
};

export const CRM_PROVIDERS: Record<CrmProviderId, CrmProviderDefinition> = {
  haive_native: {
    id: 'haive_native',
    label: 'HaiVE workspace',
    description: 'Deals, quotes and customers created directly in HaiVE.',
    integrationProviders: [],
    modules: ['deals', 'quotes', 'contacts', 'accounts', 'pipelines', 'owners', 'notes', 'tags'],
    terminology: DEFAULT_TERMS,
    // Native records are already in HaiVE's own model — nothing to map.
    fieldMappings: {},
    statusMapping: { won: ['won'], lost: ['lost'] },
    syncSupported: false,
  },
  prospectconnect: {
    id: 'prospectconnect',
    // Pantheras CRM (its connector id stays "prospectconnect" — stored on
    // existing credentials and data sources).
    label: 'Pantheras CRM',
    description: 'Pantheras CRM — deals, quotations, payments and customers, synced every few minutes.',
    integrationProviders: ['crm', 'prospectconnect'],
    modules: ['deals', 'quotes', 'contacts', 'accounts', 'pipelines', 'owners', 'notes', 'tags', 'products'],
    terminology: DEFAULT_TERMS,
    // The field names crm_mongo_sync.py has always read (confirmed live).
    fieldMappings: {
      deals: {
        externalId: 'id',
        name: 'name',
        amount: 'monetary_value',
        status: 'deal_status',
        stage: 'stage_id',
        pipeline: 'pipeline_id',
        closeDate: 'expected_closing_date',
        owner: 'sales_person',
      },
      quotes: {
        externalId: '_id',
        name: 'quote_name',
        amount: 'quote_amount',
        status: 'quote_status',
        approvalStatus: 'client_approval_status',
        currency: 'currency',
        number: 'ticket_number',
        // Both may be a nested object or a bare id — the sync takes the id.
        dealRef: 'deal',
        owner: 'quote_owner',
        ownerName: 'quote_owner.name',
        customerCompany: 'client_details.company_name',
        customerName: 'client_details.name',
        customerEmail: 'client_details.email',
        customerPhone: 'client_details.phone',
        expirationDate: 'expiration_date',
        createdAt: 'date_created',
      },
      // "name" is first_name + last_name, put together by the sync (Pantheras sends no full name).
      contacts: {
        externalId: 'id',
        name: 'name',
        email: 'email',
        phone: 'phone',
        company: 'company_name',
        createdAt: 'date_created',
      },
    },
    statusMapping: { won: ['won'], lost: ['lost'] },
    syncSupported: true,
  },
  hubspot: {
    id: 'hubspot',
    label: 'HubSpot',
    description: 'HubSpot CRM — deals, companies and contacts through a private-app token.',
    integrationProviders: ['hubspot'],
    modules: ['deals', 'contacts', 'accounts', 'pipelines', 'owners'],
    terminology: {
      deal: 'Deal',
      quote: 'Quote',
      contact: 'Contact',
      account: 'Company',
    },
    fieldMappings: {
      deals: {
        externalId: 'id',
        name: 'properties.dealname',
        amount: 'properties.amount',
        status: 'properties.dealstage',
        stage: 'properties.dealstage',
        pipeline: 'properties.pipeline',
        closeDate: 'properties.closedate',
        owner: 'properties.hubspot_owner_id',
        createdAt: 'properties.createdate',
      },
      contacts: {
        externalId: 'id',
        name: 'properties.firstname',
        email: 'properties.email',
        phone: 'properties.phone',
        company: 'properties.company',
      },
      accounts: {
        externalId: 'id',
        name: 'properties.name',
        domain: 'properties.domain',
      },
    },
    // HubSpot's default pipeline stage ids for a closed deal.
    statusMapping: { won: ['closedwon'], lost: ['closedlost'] },
    syncSupported: true,
  },
  salesforce: {
    id: 'salesforce',
    label: 'Salesforce',
    description: 'Salesforce Sales Cloud — opportunities, accounts and contacts.',
    integrationProviders: ['salesforce'],
    modules: ['deals', 'contacts', 'accounts', 'pipelines', 'owners'],
    terminology: {
      deal: 'Opportunity',
      quote: 'Quote',
      contact: 'Contact',
      account: 'Account',
    },
    fieldMappings: {
      deals: {
        externalId: 'Id',
        name: 'Name',
        amount: 'Amount',
        status: 'StageName',
        stage: 'StageName',
        closeDate: 'CloseDate',
        owner: 'OwnerId',
        createdAt: 'CreatedDate',
      },
      contacts: {
        externalId: 'Id',
        name: 'Name',
        email: 'Email',
        phone: 'Phone',
        company: 'Account.Name',
      },
      accounts: { externalId: 'Id', name: 'Name', domain: 'Website' },
    },
    statusMapping: { won: ['closed won'], lost: ['closed lost'] },
    syncSupported: true,
  },
  zoho: {
    id: 'zoho',
    label: 'Zoho CRM',
    description: 'Zoho CRM — deals, accounts and contacts.',
    integrationProviders: ['zoho', 'zohocrm'],
    modules: ['deals', 'contacts', 'accounts', 'pipelines', 'owners'],
    terminology: DEFAULT_TERMS,
    fieldMappings: {
      deals: {
        externalId: 'id',
        name: 'Deal_Name',
        amount: 'Amount',
        status: 'Stage',
        stage: 'Stage',
        pipeline: 'Pipeline',
        closeDate: 'Closing_Date',
        owner: 'Owner.id',
        createdAt: 'Created_Time',
      },
      contacts: {
        externalId: 'id',
        name: 'Full_Name',
        email: 'Email',
        phone: 'Phone',
        company: 'Account_Name.name',
      },
      accounts: { externalId: 'id', name: 'Account_Name', domain: 'Website' },
    },
    statusMapping: {
      won: ['closed won'],
      lost: ['closed lost', 'closed-lost to competition'],
    },
    syncSupported: true,
  },
  gorilladash: {
    id: 'gorilladash',
    label: 'Gorilla Dash',
    description: 'Gorilla Dash — enquiries (leads) and people, synced incrementally.',
    integrationProviders: ['gorilladash'],
    // Gorilla Dash has enquiries and people; it has no quotes, deal values or
    // won/lost status, so revenue, pipeline and conversion metrics say
    // "not supported" rather than showing zero.
    modules: ['deals', 'contacts'],
    terminology: {
      deal: 'Enquiry',
      quote: 'Quote',
      contact: 'Person',
      account: 'Location',
    },
    fieldMappings: {
      deals: {
        externalId: 'id',
        // Computed by the sync: "First Last (Business)" — HaiVE's name is one field.
        name: '_display_name',
        createdAt: 'created_at',
      },
      contacts: {
        externalId: 'id',
        name: '_display_name',
        email: 'email',
        phone: 'mobile',
        company: 'business_name',
      },
    },
    statusMapping: { won: [], lost: [] },
    syncSupported: true,
  },
  // Hoops (hoopscrm.com), through its invitation-only Extended API (API key
  // generated in Hoops → Settings → Integrations). Read once a night after
  // 7:00pm AEST, as Hoops requires (syncDefaults.window). Each transaction — a
  // quote/SalesDoc with the job it became — is a deal and its quotation; each
  // customer an account, its contacts contacts. The "_" fields are computed by
  // the adapter (python-agent/app/integrations/hoops.py): a sale is won when
  // its job is created (dated by the job, as Hoops' jobs report counts it);
  // every quote created but not won — sent, at a follow-up step, on hold, a
  // draft, or accepted with no job yet — is open, and the open quotes are the
  // pipeline; lost when it's voided or lost. (Was "won when accepted" until
  // 2026-11-11.)
  hoops: {
    id: 'hoops',
    label: 'Hoops CRM',
    description: 'Hoops — customers, contacts, quotes and jobs, synced every night.',
    integrationProviders: ['hoops'],
    modules: ['deals', 'quotes', 'contacts', 'accounts'],
    terminology: { deal: 'Sale', quote: 'Quote', contact: 'Contact', account: 'Customer' },
    fieldMappings: {
      deals: {
        externalId: '_id',
        name: '_name',
        amount: 'total',
        status: '_status',
        stage: '_stage',
        closeDate: '_closeDate',
        owner: 'ownerId',
        createdAt: 'createdAt',
      },
      quotes: {
        externalId: '_id',
        name: '_name',
        amount: 'total',
        status: '_quoteStatus',
        approvalStatus: '_approval',
        currency: '_currency',
        number: 'number',
        // A transaction is both the deal and its quotation: same id.
        dealRef: '_id',
        owner: 'ownerId',
        ownerName: '_ownerName',
        customerCompany: '_customerCompany',
        customerName: '_contactName',
        customerEmail: '_email',
        customerPhone: '_phone',
        expirationDate: 'deadline',
        createdAt: 'createdAt',
      },
      contacts: { externalId: '_id', name: '_name', email: 'email', phone: 'phone', company: '_company', createdAt: '_createdAt' },
      accounts: { externalId: '_id', name: 'name', domain: '_domain' },
    },
    // Sources saved with earlier words (accepted, completed; invoiced) are moved
    // to these once by python-agent (integrations/hoops_won_rule.py).
    statusMapping: { won: ['job'], lost: ['voided'] },
    syncSupported: true,
    syncDefaults: { intervalMinutes: 1440, window: { utcOffsetMinutes: 600, start: '19:00', end: '05:00', label: 'AEST' } },
    defaultCurrency: 'AUD',
  },
  // Any app in the organization's Zapier account: a Zap's trigger
  // ("New Customer", "New Job") posts each new record to this source's own
  // webhook (see webhook-sources.service.ts). Push-only — nothing to sync, and
  // an organization can have several (one per app), each its own source.
  zapier: {
    id: 'zapier',
    label: 'Zapier',
    description: 'Records sent from an app in your Zapier account as they are created.',
    integrationProviders: [],
    modules: ['deals', 'contacts', 'accounts'],
    terminology: DEFAULT_TERMS,
    // Filled in from the first record received (webhook-sources.service.ts ->
    // guessMappings), then editable like any other source.
    fieldMappings: {},
    statusMapping: {
      won: ['won', 'completed', 'complete', 'closed won'],
      lost: ['lost', 'cancelled', 'canceled', 'closed lost'],
    },
    syncSupported: false,
    connection: 'push',
  },
  custom: {
    id: 'custom',
    label: 'Other CRM',
    description: 'Any other CRM — map its fields to HaiVE’s in Settings → Data Sources.',
    integrationProviders: [],
    modules: ['deals'],
    terminology: DEFAULT_TERMS,
    fieldMappings: {},
    statusMapping: { won: ['won'], lost: ['lost'] },
    syncSupported: false,
  },
};

// "gorilla_dash", "Gorilla-Dash" and "gorilladash" are the same CRM: integration
// names are compared without case or separators, so a CRM connected from the
// generic Integrations page under a slightly different name is still found.
function integrationKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Which CRM an integration_credentials.provider value belongs to, if any. */
export function crmProviderForIntegration(integrationProvider: string): CrmProviderDefinition | null {
  const needle = integrationKey(integrationProvider);
  return Object.values(CRM_PROVIDERS).find((p) => p.integrationProviders.some((name) => integrationKey(name) === needle)) ?? null;
}

export function connectionOf(provider: CrmProviderDefinition): CrmConnection {
  return provider.connection ?? (provider.syncSupported ? 'pull' : 'none');
}

/** Providers whose records are pushed to a HaiVE webhook (no credential in HaiVE, nothing to pull). */
export const PUSH_PROVIDERS: CrmProviderId[] = Object.values(CRM_PROVIDERS)
  .filter((p) => p.connection === 'push')
  .map((p) => p.id);

export const CRM_INTEGRATION_PROVIDERS: string[] = Object.values(CRM_PROVIDERS).flatMap((p) => p.integrationProviders);
