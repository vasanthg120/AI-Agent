import json
import re

from bson import ObjectId

from app.memory.mongo_client import get_db

SPEC = {
    "name": "crm_source_records",
    "description": (
        "Read the CRM records HaiVE holds for ONE specific data source — e.g. 'Hoops' (records sent from Zapier), "
        "'Gorilla Dash', 'Customized Haive CRM', 'HubSpot'. Every record comes from that source only; nothing is "
        "borrowed from another. 'sources' lists the organization's data sources, what each one holds and which modules "
        "it has — call it first when unsure. Modules: deals (a source may call them opportunities, enquiries or jobs), "
        "contacts, accounts (companies/customers), quotes. To compare two sources, call 'records' once per source."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["sources", "records"]},
            "source": {"type": "string", "description": "records: the data source's name or key (e.g. 'Hoops', 'gorilladash')."},
            "module": {"type": "string", "enum": ["deals", "contacts", "accounts", "quotes"]},
            "search": {"type": "string", "description": "Filter by name/email (case-insensitive)."},
            "status": {"type": "string", "enum": ["open", "won", "lost"], "description": "deals only."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Default 20."},
        },
        "required": ["action"],
    },
}

_COLLECTIONS = {"deals": "crm_deals", "contacts": "crm_contacts", "accounts": "crm_accounts", "quotes": "crm_quotes"}
_FIELDS = {
    "deals": ["name", "dealStatus", "monetaryValue", "stageId", "expectedClosingDate", "createdAt", "externalId"],
    "contacts": ["name", "email", "phone", "company", "createdAt", "externalId"],
    "accounts": ["name", "domain", "createdAt", "externalId"],
    "quotes": ["quoteName", "quoteNumber", "quoteAmount", "currency", "clientApprovalStatus", "clientDetails", "createdAt", "externalId"],
}


def _sources(organization_id: str) -> list[dict]:
    return list(get_db().crm_data_sources.find({"organizationId": organization_id}))


def _find_source(sources: list[dict], wanted: str) -> dict | None:
    wanted = wanted.strip().lower()
    for s in sources:
        if wanted in (str(s["_id"]), s.get("key", "").lower(), s.get("label", "").lower()):
            return s
    matches = [s for s in sources if wanted in s.get("label", "").lower() or wanted in s.get("provider", "").lower()]
    return matches[0] if len(matches) == 1 else None


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    if not organization_id:
        return "No organization context available."
    db = get_db()
    sources = _sources(organization_id)
    if not sources:
        return "No CRM data sources exist for this organization yet."

    if tool_input["action"] == "sources":
        lines = []
        for s in sources:
            sid = str(s["_id"])
            counts = {m: db[c].count_documents({"organizationId": organization_id, "dataSourceId": sid}) for m, c in _COLLECTIONS.items()}
            held = ", ".join(f"{n} {m}" for m, n in counts.items() if n) or "no records yet"
            terms = s.get("terminology") or {}
            sync = s.get("sync") or {}
            lines.append(
                f"- {s['label']} (key '{s['key']}', {s.get('status', 'active')}{', default' if s.get('isDefault') else ''}): "
                f"{held}; modules {', '.join(s.get('modules') or [])}; deals are called '{terms.get('deal', 'Deal')}'"
                + (f"; last sync {sync.get('lastSyncAt')} ({sync.get('lastStatus')})" if sync.get("lastSyncAt") else "")
            )
        return "Data sources (each kept separate):\n" + "\n".join(lines)

    source = _find_source(sources, tool_input.get("source") or "")
    if not source:
        names = ", ".join(s["label"] for s in sources)
        return f"No data source matches '{tool_input.get('source')}'. Available: {names}."
    module = tool_input.get("module") or "deals"
    if module not in (source.get("modules") or []) and module in ("deals", "quotes", "contacts", "accounts"):
        return f"{source['label']} doesn't provide {module} — it has: {', '.join(source.get('modules') or [])}."

    query: dict = {"organizationId": organization_id, "dataSourceId": str(source["_id"])}
    if tool_input.get("search"):
        pattern = re.compile(re.escape(tool_input["search"].strip()), re.I)
        name_field = "quoteName" if module == "quotes" else "name"
        query["$or"] = [{name_field: pattern}, {"email": pattern}]
    if module == "deals" and tool_input.get("status"):
        query["dealStatus"] = tool_input["status"]
    limit = min(int(tool_input.get("limit") or 20), 50)
    collection = db[_COLLECTIONS[module]]
    total = collection.count_documents(query)
    rows = list(collection.find(query, {f: 1 for f in _FIELDS[module]}).sort("createdAt", -1).limit(limit))
    for row in rows:
        row["id"] = str(row.pop("_id"))
    header = f"{total} {module} from {source['label']} (showing {len(rows)}; source: {source['label']} only)"
    if not rows:
        return f"{header}. Nothing matched."
    return header + "\n" + json.dumps(rows, ensure_ascii=False, default=str)[:8000]
