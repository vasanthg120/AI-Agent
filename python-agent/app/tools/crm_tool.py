from app.integrations import prospectconnect

SPEC = {
    "name": "crm_contact",
    "description": (
        "Create, update, list, or look up contacts in the CRM. "
        "Use 'upsert' to create a new contact (omit contact_id) or update an existing "
        "one (pass contact_id) — either email or phone is required. Use 'search_by_ids' "
        "to fetch full details for known contact IDs. Use 'list' to browse or search all "
        "contacts, with optional text search and pagination."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["upsert", "search_by_ids", "list"],
                "description": "Which CRM operation to perform.",
            },
            "contact_id": {
                "type": "string",
                "description": "upsert only — existing contact ID to update. Omit to create a new contact.",
            },
            "email": {"type": "string", "description": "upsert only — required if phone is omitted."},
            "phone": {"type": "string", "description": "upsert only — required if email is omitted."},
            "first_name": {"type": "string", "description": "upsert only."},
            "last_name": {"type": "string", "description": "upsert only."},
            "name": {"type": "string", "description": "upsert only — full display name."},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "upsert only."},
            "ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "search_by_ids only — required. Contact IDs to fetch.",
            },
            "search_text": {"type": "string", "description": "list only — filter by name or email."},
            "limit": {
                "type": "integer",
                "description": "list only — max contacts to return (default 50, CRM max 200).",
            },
            "search_after": {
                "type": "integer",
                "description": "list only — pagination offset; pass the value from the previous page to continue.",
            },
            "fields": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "list only — which contact fields to return. Defaults to a compact set "
                    "(name, email, phone, tags, stage, date). Only widen this if you need "
                    "something not in that default set — full contact records are large."
                ),
            },
        },
        "required": ["action"],
    },
}

# The CRM's raw contact object is huge and deeply nested (user/team/activity
# detail, session ids, etc.) — a default 50-contact page can run ~200KB /
# ~50K tokens. The CRM API supports server-side field projection, so unless
# the caller asks for more, request only what's actually useful for chat.
_LIST_DEFAULT_FIELDS = ["name", "first_name", "last_name", "email", "phone", "tags", "stage_id", "date_created"]


def _fetch_raw_contacts(*, search_after=0, limit=50, search_text="", fields=None, organization_id=None) -> dict:
    """Parsed {"count", "data"} from /contact/search/contact — used by run()
    (list action) and by the RAG business sync job, which needs individual
    contact records rather than a pre-stringified blob. organization_id is
    None for the sync job (not yet org-scoped), matching the .env-fallback
    behavior it always had."""
    base_url, api_key = prospectconnect.resolve_credentials(organization_id)
    if not base_url or not api_key:
        return {"count": 0, "data": []}
    payload = {
        "search_after": search_after,
        "limit": limit,
        "order_by": "date_created",
        "sort_direction": "desc",
        "search_text": search_text,
        "fields": fields or _LIST_DEFAULT_FIELDS,
    }
    return prospectconnect.post_json(base_url, api_key, "/contact/search/contact", payload)


def run(tool_input: dict, context: dict) -> str:
    action = tool_input.get("action", "upsert")
    organization_id = context.get("organization_id")
    base_url, api_key = prospectconnect.resolve_credentials(organization_id, context.get("user_id", ""))

    if not base_url or not api_key:
        return "No CRM is connected yet. Ask the user to connect one via the Integrations page."

    if action == "search_by_ids":
        ids = tool_input.get("ids") or []
        if not ids:
            return "search_by_ids requires at least one contact id in 'ids'."
        return prospectconnect.post(base_url, api_key, "/contact/search/contact-by-ids", {"ids": ids, "depth": 0})

    if action == "list":
        return str(_fetch_raw_contacts(
            search_after=tool_input.get("search_after", 0),
            limit=tool_input.get("limit", 50),
            search_text=tool_input.get("search_text") or "",
            fields=tool_input.get("fields"),
            organization_id=organization_id,
        ))

    data = {
        key: tool_input[key]
        for key in ("contact_id", "email", "phone", "first_name", "last_name", "name", "tags")
        if tool_input.get(key) is not None
    }
    if not data.get("email") and not data.get("phone"):
        return "upsert requires either an email or a phone number."
    return prospectconnect.post(base_url, api_key, "/contact/upsert", {"data": data})