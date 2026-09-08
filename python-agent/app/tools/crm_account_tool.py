from app.integrations import prospectconnect

SPEC = {
    "name": "crm_account",
    "description": "List or search accounts (companies/organizations) in the CRM.",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Filter by account name."},
            "limit": {"type": "integer", "description": "Max accounts to return (default 25)."},
            "offset": {"type": "integer", "description": "Pagination offset (default 0)."},
            "fields": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Which account fields to return. Defaults to a compact set (name, domain, "
                    "city, industry) — full account records embed nested contact lists and are large."
                ),
            },
        },
        "required": [],
    },
}

_LIST_DEFAULT_FIELDS = ["name", "domain", "city", "industry", "revenue"]


def _fetch_raw_accounts(*, offset=0, limit=25, name="", fields=None, organization_id=None):
    """Parsed response from /account/fetch-account-list — used by run() and
    by the RAG business sync job."""
    base_url, api_key = prospectconnect.resolve_credentials(organization_id)
    if not base_url or not api_key:
        return {"data": []}
    payload = {
        "offset": offset,
        "limit": limit,
        "name": name,
        "fields": fields or _LIST_DEFAULT_FIELDS,
    }
    return prospectconnect.post_json(base_url, api_key, "/account/fetch-account-list", payload)


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    base_url, api_key = prospectconnect.resolve_credentials(organization_id, context.get("user_id", ""))
    if not base_url or not api_key:
        return "No CRM is connected yet. Ask the user to connect one via the Integrations page."

    return str(_fetch_raw_accounts(
        offset=tool_input.get("offset", 0),
        limit=tool_input.get("limit", 25),
        name=tool_input.get("name") or "",
        fields=tool_input.get("fields"),
        organization_id=organization_id,
    ))