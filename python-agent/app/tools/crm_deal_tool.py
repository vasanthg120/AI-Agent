from app.integrations import prospectconnect

SPEC = {
    "name": "crm_deal",
    "description": "List or search deals in the CRM, with optional pipeline scoping.",
    "input_schema": {
        "type": "object",
        "properties": {
            "search": {"type": "string", "description": "Filter by deal name."},
            "pipeline_id": {
                "type": "string",
                "description": "Scope to one sales pipeline. Omit to return deals across all pipelines.",
            },
            "page": {"type": "integer", "description": "1-indexed page number (used with page_limit)."},
            "offset": {"type": "integer", "description": "Pagination offset — takes precedence over page if set."},
            "page_limit": {"type": "integer", "description": "Max deals to return (default 25)."},
            "fields": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Which deal fields to return. Defaults to a compact set (name, stage, status, "
                    "value, closing date, contacts) — full deal records embed nested product/ticket "
                    "detail and are large."
                ),
            },
        },
        "required": [],
    },
}

_LIST_DEFAULT_FIELDS = [
    "name",
    "stage_id",
    "deal_status",
    # ProspectConnect quirk, confirmed empirically: requesting the field by
    # its own response key ("monetary_value") returns nothing whenever any
    # other field is requested alongside it; requesting "value" instead
    # reliably returns the same data under the "monetary_value" key in the
    # response. Do not "fix" this back to "monetary_value" — that silently
    # breaks deal value for every caller of this default field list.
    "value",
    "expected_closing_date",
]


def _fetch_raw_deals(*, page=1, offset=0, page_limit=25, search="", pipeline_id=None, fields=None, organization_id=None) -> dict:
    """Parsed {"total", "deal"} from /deal/getDealsByBusinessId — used by
    run() and by the RAG business sync job."""
    base_url, api_key = prospectconnect.resolve_credentials(organization_id)
    if not base_url or not api_key:
        return {"total": 0, "deal": []}
    payload = {
        "page": page,
        "offset": offset,
        "page_limit": page_limit,
        "search": search,
        "fields": fields or _LIST_DEFAULT_FIELDS,
    }
    if pipeline_id:
        payload["pipelineId"] = pipeline_id
    return prospectconnect.post_json(base_url, api_key, "/deal/getDealsByBusinessId", payload)


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    base_url, api_key = prospectconnect.resolve_credentials(organization_id, context.get("user_id", ""))
    if not base_url or not api_key:
        return "No CRM is connected yet. Ask the user to connect one via the Integrations page."

    return str(_fetch_raw_deals(
        page=tool_input.get("page", 1),
        offset=tool_input.get("offset", 0),
        page_limit=tool_input.get("page_limit", 25),
        search=tool_input.get("search") or "",
        pipeline_id=tool_input.get("pipeline_id"),
        fields=tool_input.get("fields"),
        organization_id=organization_id,
    ))