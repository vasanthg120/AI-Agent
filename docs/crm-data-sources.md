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

The existing screens (dashboards, cards, charts, routes, layout) are
unchanged, and so are the dashboard endpoints and their response shape. This
layer works behind them as a compatibility layer:

- Each CRM's adapter maps its records onto HaiVE's existing model.
- Dashboards read the organization's **default** source. The app sends no
  source header, so the backend falls back to the default.
- A metric a CRM can't provide comes back as the existing screens already show
  it (0 / empty); it is never invented.

The only new screen is `features/settings/tabs/DataSourcesSettings.tsx`, plus
the Gorilla Dash and Zapier dialogs. It covers sources, choosing the default,
sync now, field mapping, won/lost and stages, capabilities, naming and sync
interval. `services/dataSourcesService.ts` backs it.

The backend still accepts `X-Data-Source` (`default` | a source id |
`unified`) for API clients, but no screen sends it.

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

## 7. Zapier (any Zapier app)

Zapier has no "read your existing records" for most apps (Hoops: triggers New
Customer / New Job, actions Create Customer / Create Job; Gorilla Dash: trigger
New Weekly Digest Article, action Create Enquiry). HaiVE therefore uses Zapier
in two independent, generic ways. Neither names an individual app in code.
(Hoops itself is read directly through its Extended API — see §9.)

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

- "Add an app" creates a data source, e.g. "Job app". It has its own key, shown
  once; only a SHA-256 hash is stored, and "Replace key" rotates it. It also
  has an address per record type:
  `POST /data-source-webhooks/<sourceId>/<deals|contacts|accounts>` with
  header `X-HaiVE-Key` (or `?key=`).
- A Zap (trigger: the app's "New Customer" → action: Webhooks by Zapier POST,
  JSON) sends each new record.
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

Hoops history comes through its direct integration (§9), Gorilla Dash history
through its own (§6).

## 8. Provider-aware integrations (Pantheras CRM, Hoops CRM, Gorilla Dash)

The Integrations page is the one place CRMs are connected and managed
(`backend/src/crm-integrations/`, frontend `features/integrations/`).

- **Naming.** The CRM formerly shown as "Customized Haive CRM" / "CRM" is
  **Pantheras CRM**. Its connector id stays `prospectconnect` (credentials may
  also be saved as `crm`).
- **Two ways records arrive** (`provider-catalog.ts` → `connection`):
  - `pull`: HaiVE reads the CRM through its python adapter (Pantheras, Gorilla
    Dash, Hoops, HubSpot, Salesforce, Zoho).
  - `push`: an app sends each new record to a HaiVE webhook (generic Zapier
    sources).
- **Hoops CRM** is a pull provider read once a night — see §9.
- **Setup is provider-aware.** `CrmIntegrationsService.SETUP` says what each
  CRM asks for, what it provides and what it can't. A pull CRM is saved only
  if a first page of data can be read (`POST /sync/crm/discover`), and nothing
  is synced until the mapping has been reviewed (`skipSync`).
- **Mapping** (`mapping-intelligence.service.ts`):
  - a suggestion per HaiVE field with a confidence and reason — from the saved
    mapping, from field names and example values, and (on request, billed)
    from the AI for what is still unsure;
  - a preview on the CRM's own sample records (`crm_source_samples`);
  - validation (a record-ID field is required; one CRM field can't feed two
    HaiVE fields);
  - versions with restore (`crm_mapping_versions`).
  Suggestions never change a mapping by themselves.
- **Sync history and errors.** Every sync and every pushed delivery is
  recorded in `crm_sync_runs`. A failure is stored three ways: a plain message
  (`sync.lastError`), a kind (`auth` / `mapping` / `unreachable` /
  `rate_limit` / `other`) that decides the next step offered, and the
  technical detail, shown only behind "View technical details".
- **Adding a CRM**: a catalog entry, a python adapter (pull) or nothing
  (push), and a `SETUP` entry. Dashboards, reports, AI tools and the
  Integrations page need no changes.

## 9. Hoops CRM (Extended API)

Hoops' invitation-only Extended API (reference dated 19 Oct 2026) is read
directly. Files: `python-agent/app/integrations/hoops.py` (client, reading
rules, record shaping), `HoopsAdapter` in `crm_adapters.py`, the "nightly
sync window" in `crm_mongo_sync.py`, `backend/src/data-sources/sync-window.ts`
(the same rule, for display), the `hoops` entries in `provider-catalog.ts`,
`crm-integrations.service.ts` (`SETUP`) and `provider-rules.ts`.

**Connecting** (Integrations → Hoops CRM): the API key (Hoops → Settings →
Integrations → Generate API Key), how far back to bring in quotes (30 days, 3
months, 12 months (default), everything), and under Advanced the account's
currency (Hoops sends none; default INR) and the API address. The key is saved
as the `hoops` integration (`apiKeyBaseUrl`, header `x-api-key`, encrypted)
and kept only if a 5-record sample of transactions and of customers can be read
(2 requests). A Hoops source created in the Zapier era is converted to the API
source on connecting (Hoops mapping and schedule; its webhook key stops working).

**Hoops' rules, and where each is kept:**

| Rule | How |
|---|---|
| One request at a time per account (429 "API call already in progress") | Requests are sequential; a sync of the source can't start while one runs (`sync.runningSince` claim, stale after 45 min); a 429 is retried after 5/15/30/60 s. |
| At most once a day, after 7:00pm AEST | `sync.window` = 19:00–05:00 at UTC+10 (AEST has no daylight saving). Python refuses every trigger outside it or after a successful sync that night (`status: "deferred"` with the reason and the next opening); a failed night is retried an hour later, at most 3 tries. |
| Sync incrementally with `since` | `since` = start of the last successful sync (`sync.cursor`); records are upserted on their `_id`, so its inclusiveness is harmless. |
| Start small; backfill progressively | First night: transactions from the last 30 days (≤ 20 pages). Each later night: 5 more pages down the newest-first list, until the chosen history start. Position in `sync.adapterState`; records created since the last walk shift it down; it restarts 10 places early in case of deletions. Customers: the whole list, 5 pages a night (the history choice applies to quotes only). |
| `skip`/`limit`, never `page`/`pageSize` | Pages of 50 transactions / 100 customers. |
| 500 with `timeout: true` | The page size is halved (down to 5) and kept for the rest of that sync. |

**What the records become** (default mapping; the `_` fields are computed in
`hoops.py`, editable in the mapping editor like any other):

- Each transaction (quote/SalesDoc with its jobs and latest invoice) is a
  **deal** and that deal's **quotation**, sharing the `_id` (`dealRef: _id`).
  - Deal: name `#number · customer · reference`, value `total`, owner
    `ownerId` (→ Settings → Deal Assignment), stage (Quote sent / Accepted /
    In production / Completed / Voided), line items as product lines.
  - **Won when the customer accepts the quote**, dated `acceptedAt` (the
    revenue month); lost when voided (`voidedAt`); open ones carry the quote
    deadline. Decided with the user on 2026-10-21.
  - Quotation: status voided / accepted / viewed / sent, approval, number,
    customer and contact details, tax (`taxTotal`) and shipping as charge
    lines, the configured currency. **Voided quotations are left out of
    Reporting** (`QuotationSalesService` excludes `voided` with `draft`).
- Each **company** customer is an account (domain from website or email).
  Each contact is a contact with its customer as company; a customer with no
  contacts is its own contact. Creation dates come from the ids (ObjectIds).

**Read only.** HaiVE never writes to Hoops (the create/update customer
endpoints are unused).

**Confirmed with live data (21 Oct 2026, Fully Promoted Surry Hills):**
- A transaction keeps its customer, contact and owner inside `summary`
  (`summary.customer.name`, `summary.contact.firstName`…, `summary.owner`),
  not at the top level as the reference shows; both are read. Line-item numbers
  arrive as text. `number` is a string.
- Its own `status` is the sale's state: CREATED (draft — not counted as sent),
  SENT, ACCEPTED (won), LOST (lost, but still a sent quotation in Reporting, as
  Pantheras' lost ones are), and the account's own steps ("FOLLOW UP 1–3",
  "Provide Samples!"), which are open quotes at that step and become the deal's
  pipeline stage. A `voided` flag (or VOID/CANCEL) means not a sale at all:
  left out of Reporting.
- Each deal keeps a compact copy of its transaction (`sourceData`: status,
  flags, job, invoice, summary) — Hoops never triggers the "re-read everything
  to fill missing details" pass (`rereads_for_details = False`).

**Currency.** Hoops is Australian and sends amounts without a currency: a Hoops
source is AUD (`provider-catalog.ts` `defaultCurrency`, `metadata.currency`,
editable under Advanced when connecting). Each CRM's amounts are shown in its
own currency (`data-sources/scope-currency.ts`): the dashboards, Reporting and
their exports in the currency of the CRM chosen for dashboards (frontend
`stores/currencyStore` + `utils/currency`, refreshed by AppLayout from
`/data-sources/overview`), the Customers page per customer. Reporting reads only
the CRM chosen for dashboards (`QuotationSalesService` applies the data-source
scope), so rupees and dollars are never added together. Sales targets are one per
store/person, month **and currency**: only targets in the shown CRM's currency
apply (the old unique index is replaced on startup).

**Repair of Zapier-era sources.** A Hoops source without its nightly window (set
up before the API, whether or not its old webhook key remains) is given the API
settings on every backend start and on connecting (`upgradeLegacyHoops` /
`applyProviderSetup`): modules, won/lost words, mapping (extra admin fields
kept), schedule, AUD. Still unconfirmed: whether sibling quote options share a
number (each is its own deal today).

**All of Hoops in HaiVE (user, 2026-10-27).**
- An open quote with no deadline in Hoops is expected 30 days after it was
  created (`hoops.py` `OPEN_QUOTE_DAYS`), so every open quote is in a month's
  pipeline; a deadline set in Hoops always wins. Won/lost dates are unchanged.
- History reads 20 pages a night (1,000 quotes / 2,000 customers), up from 5.
- Hoops salespeople without a HaiVE login appear in the sales team views
  (leaderboard, team breakdown, Deal Performance) by their Hoops name, as
  `hoops:<Hoops id>` (`crm/hoops-salespeople.ts`); the deal filter opens their
  own sales. A linked Hoops owner is credited to the HaiVE user. Other CRMs'
  unlinked owners, and Agent Activity's list of accounts, are unchanged.
- A Hoops sales target is not set automatically: Settings → Sales Targets, in
  A$, while Hoops is shown on dashboards.

