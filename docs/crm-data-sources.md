# CRM data sources — audit and architecture

HaiVE takes business data from CRMs and mailboxes. Until September 2026 it
assumed exactly one CRM — the customised CRM (internal connector id
`prospectconnect`, shown to customers only as "CRM") — with that CRM's field
names, API paths and status words hard-coded. This document records the audit
of those assumptions and the provider-agnostic data-source architecture that
replaced them.

## 1. Audit — where the customised CRM was hard-coded

| # | Location | Assumption | Status |
|---|----------|------------|--------|
| 1 | `python-agent/app/integrations/crm_mongo_sync.py` | Field names `name`, `monetary_value`, `deal_status`, `stage_id`, `pipeline_id`, `expected_closing_date`, `sales_person`, `quote_owner`, `client_details.*`, … read directly | **Fixed** — read through each source's field mappings (`crm_adapters.to_canonical`) |
| 2 | same | Won/lost detected by the substring "won"/"lost" | **Fixed** — per-source won/lost values (`map_status`) |
| 3 | same | Orgs to sync chosen by `provider in ("crm", "prospectconnect")`; any other CRM never synced | **Fixed** — driven by `crm_data_sources` (HubSpot, Salesforce, Zoho adapters added) |
| 4 | same | Records keyed `{organizationId, externalId}` — two CRMs with the same record id would overwrite each other | **Fixed** — keyed `{organizationId, dataSourceId, externalId}`; unique index migrated |
| 5 | same | Owner-mapping provider fixed to `"prospectconnect"` | **Fixed** — the source's provider |
| 6 | `crm_deals`, `crm_quotes`, `crm_contacts`, `crm_accounts` | No record said which CRM it came from; synced and in-app records mixed | **Fixed** — every record carries `dataSourceId` (+ `sourceProvider`); existing records backfilled |
| 7 | 15 backend services reading deals, 13 reading quotes (dashboards, analytics, reporting, royalty, customer activity, vendor profitability, EOD, tasks, BI) | Read every record of the organization | **Fixed centrally** — `dataSourceScopePlugin` limits every read to the selected source(s); no per-service change needed, and future readers are covered automatically |
| 8 | `python-agent/app/integrations/prospectconnect.py` `resolve_credentials` tier 3 | The `.env` CRM (`CRM_BASE_URL`) was used for *any* organization without its own CRM — could show one organization another's CRM data (not configured in this deployment, so latent) | **Fixed** — only for callers with no organization |
| 9 | same, used by the sync | A missing CRM credential fell back to HaiVE's own backend — the sync would copy HaiVE's records into the CRM's data source | **Fixed** — the sync uses `resolve_external_credentials` (never falls back) |
| 10 | `python-agent/app/tools/crm_quote_tool._fetch_raw_quotes` | Trims quotes to a fixed field list — a custom field an admin maps would vanish | **Fixed for the sync** — adapters fetch full records |
| 11 | `backend/src/integrations/integrations.service.ts` `CRM_PROVIDERS` | Only `crm`/`prospectconnect` triggered a sync | **Fixed** — every CRM in the provider catalog; connecting/disconnecting reconciles data sources |
| 12 | `backend/src/crm/customer-grouping.util.ts` | Customers grouped by a CRM's own account id — the same company in two CRMs counted twice | **Fixed** — grouped by normalised account name |
| 13 | `backend/src/crm/crm.service.ts` `upsertContact` | Could match and overwrite a contact synced from another CRM sharing an email | **Fixed** — limited to HaiVE workspace records |
| 14 | Dashboard (frontend) | Every metric shown as a number, zero when the CRM can't provide it; no indication of source | **Fixed** — per-metric availability, "Not supported by <CRM>", source line per tab |
| 15 | `python-agent/app/tools/crm_*_tool.py` (AI agent) | Call the customised CRM's URL paths (`/deal/getDealsByBusinessId`, …) | **Contained** — only used with the customised CRM's credentials; any other CRM's organization reads HaiVE's source-scoped mirror through the native backend fallback. Notes/tags/products for other CRMs return empty (see §5) |
| 16 | `email-intelligence-sync.service.ts` (background) | Correlates incoming emails to customers across all CRM data | **Intentional** — matching an email to any known customer; no figures are shown from it |

Email data (Outlook, Gmail) was already stored separately (`email_intelligence_items`,
keyed by mailbox). It is now also *labelled*: email metrics name their mailbox
source, and switching CRM never changes them.

## 2. Architecture

```
Integrations (credentials)          crm_data_sources (one per CRM + "HaiVE workspace")
        │ connect / disconnect ──────►  provider, connection id, modules, terminology,
        │                               field mappings, won/lost + stage mappings,
        │                               available fields, sync state, default flag
        ▼                                          │
python-agent crm_mongo_sync ── adapter per provider ┘ (transport only; meaning from mappings)
        │ writes records tagged {dataSourceId}
        ▼
crm_deals / crm_quotes / crm_contacts / crm_accounts
        ▲
        │ every read scoped by dataSourceScopePlugin (AsyncLocalStorage scope)
backend request ── DataSourceScopeInterceptor ── X-Data-Source: default | <id> | unified
        ▲
frontend ── top-bar DataSourceSwitcher, MetricGate / SourceLine on the dashboard,
            Settings → Data Sources
```

### Backend (`backend/src/data-sources/`)

- `provider-catalog.ts` — the only place a CRM's vocabulary lives: modules,
  terminology, default field mappings and won/lost values for the customised
  CRM, HubSpot, Salesforce, Zoho, "Other CRM", and the built-in HaiVE workspace.
  HaiVE's canonical fields are defined here too.
- `metric-catalog.ts` — every metric and what it needs (modules, mapped fields,
  status mapping). `crmMetricSupport` says whether a source can provide it and why not.
- `schemas/data-source.schema.ts` — `crm_data_sources`: provider, connection id,
  organization, modules, field/status/stage mappings, available fields, sync
  config and last sync status, metadata.
- `data-sources.service.ts` — reconcile sources with connections, one-time
  migration (index swap + backfill), scope resolution, per-metric availability,
  admin updates (validated field paths), "sync now", per-person hidden metrics.
- `data-source-scope.interceptor.ts` + `data-source-context.ts` +
  `data-source-scope.plugin.ts` — per-request scope and automatic query scoping.

Selection rules (`resolveScope`):

- nothing / `default` → the organization's default source only;
- a source id → that source (a disconnected one too, to view its history);
- `unified` → every **connected** source — only when explicitly chosen;
- an unknown or foreign id → the default, never "everything".

Scoping rules (`dataSourceScopePlugin`): applies to `find`, `findOne`,
`countDocuments`, `distinct` and `aggregate` (first `$match`) for the request's
own organization; added with `$and` so a query's own `$or` survives; skipped for
`_id` lookups, other organizations and queries that name a `dataSourceId`;
records with no tag count as the HaiVE workspace's. New records created during a
request are stamped with the HaiVE workspace source.

Unified view: headline deal counts count a deal present in several CRMs (same
name, value and close date) once; customers are grouped by normalised company
name/email across sources.

API: `GET /data-sources/overview` (anyone), `PUT /data-sources/preferences`
(own hidden metrics), and for owners/admins `GET /data-sources`,
`GET /data-sources/catalog`, `PATCH /data-sources/:id`,
`POST /data-sources/:id/sync`, `POST /data-sources/reconcile`.

### Python (`python-agent/app/integrations/`)

- `crm_adapters.py` — one adapter per provider (customised CRM, HubSpot,
  Salesforce, Zoho): where records live, auth, paging. Plus `to_canonical`,
  `map_status`, `field_paths`.
- `crm_mongo_sync.py` — syncs each active source through its adapter and
  mappings; records last sync time/status/counts/error and the field paths seen
  (offered in the mapping editor); honours each source's own interval.
- Routes: `POST /sync/crm/run-for-org`, `POST /sync/crm/run-for-source`.

### Frontend

- `stores/dataSourceStore.ts`, `hooks/useDataSources.ts`,
  `services/dataSourcesService.ts`; `axiosClient` sends `X-Data-Source`.
- `components/data-sources/DataSourceSwitcher.tsx` (top bar),
  `MetricGate` / `SourceLine` (dashboard), `CustomizeDashboardModal`.
- `features/settings/tabs/DataSourcesSettings.tsx` — sources, default, sync now,
  field mapping, won/lost + stages, capabilities, naming and sync interval.
- Switching source clears cached results and remounts the page, so nothing from
  the previous source can linger.

## 3. Adding another CRM

1. Add an entry to `provider-catalog.ts` (label, integration provider names,
   modules, terminology, default mappings, won/lost values).
2. Add an adapter class to `crm_adapters.py` and register it in `ADAPTERS`.
3. Nothing else: dashboards, reports, scoping and the settings UI pick it up.

## 4. Deploying

1. Restart the backend (the first start migrates: replaces the
   `{organizationId, externalId}` unique indexes, creates data sources, tags
   existing records — idempotent).
2. Restart python-agent (the new sync writes `dataSourceId` and records sync status).

## 5. Known limitations / follow-ups

- HubSpot, Salesforce and Zoho adapters are tested against faked APIs only.
  HubSpot private-app tokens are long-lived; Salesforce and Zoho access tokens
  expire (OAuth refresh is not implemented yet), so those need a refresh flow
  before production use.
- The AI agent's CRM tools talk to the customised CRM directly when it is
  connected; for other CRMs they read HaiVE's mirror of the default source, and
  notes/tags/products are unavailable.
- Unified de-duplication covers the headline deal figures and customer counts;
  other unified widgets (leaderboard, funnel) count each CRM's records.
- Scheduled jobs run without a request scope (they see every source).

## 6. Gorilla Dash

Connected from Settings → Data Sources → **Gorilla Dash** (API key + secret,
checked against `/api/v1/ping`; stored encrypted as a `gorilladash`
integration). Once connected it is two things:

**A data source** (`provider: 'gorilladash'`, python `GorillaDashAdapter`)

- Enquiries → HaiVE deals (called "Enquiries"), people → contacts.
- Incremental: after the first full read, each sync passes
  `updated_after` = the *start time* of the last successful sync
  (`sync.cursor`). Changing mappings or modules clears the cursor, forcing a
  full re-read.
- `_display_name` is computed per record ("First Last (Business)") because
  HaiVE's name is a single field.
- Gorilla Dash has no quotes, deal values or won/lost status, so revenue,
  pipeline and conversion metrics show "Not supported by Gorilla Dash".
- Tribes (locations) are not synced — they're the business's own locations,
  not customers, and can't be fetched incrementally. The AI tools read them live.

**AI tools** (python `app/tools/gorilladash_*_tool.py`, Agent Builder group
"Gorilla Dash")

- `gorilladash_lookup` (read-only, cached briefly): enquiries, people, forms and
  a form's fields, locations (list / nearest / one), reviews (all ratings by
  default), knowledge and blog articles, digest, menu items, media. Lists ask
  for 25 results (the API defaults to 5 on several).
- `gorilladash_action` (sensitive, off by default): create an enquiry, update
  an enquiry's form fields or tracking data, email a person. It always returns
  a preview first, and acts only when called again with `confirmed: true`
  after the user agrees.
  - **Creating:** field names are checked against the form, and unknown ones
    are refused instead of letting Gorilla Dash drop them silently.
  - **Updating** (`PUT /api/v1/enquiries/{id}`) replaces the enquiry's whole
    field set, so the tool first finds the enquiry in the list (there is no
    single-enquiry GET; it searches up to 1,000 of the newest), merges the
    changes into its current fields and previews "from → to".
  - If an update's current fields can't be read, the tool refuses unless the
    user accepts clearing them (`replace_all`).
  - Tracking data sent on an update replaces all of the enquiry's existing
    tracking data.

Client behaviour (`app/integrations/gorilladash.py`): any 2xx is success (the
API answers 201); 401/403/422/429 become readable messages; 429 is retried
after `Retry-After`; pages are followed via `pagination.totalPages`, never more
than 1,000 per page.

To verify with a real key:

- **Record shape.** The response envelope (`data`) and field names (`id`,
  `first_name`, `last_name`, `business_name`, `email`, `mobile`, `created_at`)
  are best guesses from the request bodies in the docs. The client and mappings
  cope with variations, and after the first sync Settings → Data Sources shows
  the real field names to map.
- **Updating a lead** uses `PUT /api/v1/enquiries/{id}`, which is marked as
  unconfirmed in the endpoint list. Check it on a test enquiry first, including
  whether list records carry a `fields` array the tool can merge with.
- **Location keys.** A location key gets 403 on `tribes/search` and on other
  locations' enquiries; the connect dialog detects and labels such keys.

## 7. Zapier (Hoops, Gorilla Dash and any other Zapier app)

Zapier has no "read your existing records" for Hoops (triggers New Customer /
New Job; actions Create Customer / Create Job) or Gorilla Dash (trigger New
Weekly Digest Article; action Create Enquiry). HaiVE therefore uses Zapier in
two independent, generic ways. Neither names an individual app in code.

**1. Connector: AI actions via Zapier MCP** (`backend/src/zapier/`,
`python-agent/app/integrations/zapier_mcp.py`)

- An admin creates a Zapier MCP server at mcp.zapier.com for a custom client,
  keeps it in **Managed** mode, enables the actions HaiVE may use, and pastes
  the server's token into Settings → Data Sources → Zapier.
- The token is saved as the organization's `zapier` integration (bearer,
  encrypted). It is kept only if python-agent can list the server's actions
  (`POST /integrations/zapier/discover`); a rejected token is rolled back to
  the previous one, or removed. It is never returned to the browser.
- The discovered catalog (`zapier_catalogs`: per-app read/write actions, mode,
  last error) drives the settings panel and the AI.
- AI tool `zapier` (sensitive):
  - `actions` lists what each app offers and says plainly when an app has no
    read actions;
  - `run` executes only catalogued actions, and write actions return a preview
    until the user confirms.
- An Agentic-mode server, or a revoked or expired token (401), is detected and
  explained to both the admin and the AI.
- Each successful call costs 2 Zapier tasks.

**2. Webhook data sources: new records into HaiVE**
(`backend/src/data-sources/webhook-sources.*`, provider `zapier` in
`provider-catalog.ts`)

- "Add an app" creates a data source, e.g. "Hoops". It has its own key, shown
  once; only a SHA-256 hash is stored, and "Replace key" rotates it. It also
  has an address per record type:
  `POST /data-source-webhooks/<sourceId>/<deals|contacts|accounts>` with
  header `X-HaiVE-Key` (or `?key=`).
- A Zap (trigger: Hoops New Customer → action: Webhooks by Zapier POST, JSON)
  sends each new record.
- The key identifies exactly one source of one organization, so a request
  can't write anywhere else. Wrong or unknown keys get the same 403, and
  disconnected sources refuse records while keeping their history.
- Records are mapped with the source's own field mappings
  (`canonical-mapping.ts`, a TS twin of `crm_adapters.to_canonical` /
  `map_status`) and upserted on `{organizationId, dataSourceId, externalId}`.
  They behave like synced CRMs: source picker, dashboards and AI tools.
- The first payload proposes a mapping (id, name — built from first and last
  name when needed — email, phone, amount, status…) and records the field
  names it saw for the mapping editor.
- Webhook sources have no credential, so `reconcile()` leaves them alone.
- Zapier must reach the backend: set `PUBLIC_API_BASE_URL` (falls back to
  `CALLING_PUBLIC_BASE_URL`), otherwise the UI shows the app's own API address
  and warns when it's a local one.
- Needs a Zapier plan that includes Webhooks by Zapier.

**AI:** `crm_source_records` reads one source's stored records (never mixed)
and lists every source with counts and terminology. `integration_capabilities`
now starts with that overview plus the Zapier apps and their actions, which
answers questions like "what CRMs are connected and what can I access from
each?".

Existing Hoops history is only reachable through Hoops' own API (ask Hoops for
access). Gorilla Dash history is covered by the direct integration (§6).
