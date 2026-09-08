import requests

from app.integrations import prospectconnect

SPEC = {
    "name": "crm_quote",
    "description": "List or search quotes in the CRM, optionally scoped to a specific deal.",
    "input_schema": {
        "type": "object",
        "properties": {
            "search": {"type": "string", "description": "Filter by quote name."},
            "deal_id": {"type": "string", "description": "Only return quotes for this deal."},
            "limit": {"type": "integer", "description": "Max quotes to return (default 25)."},
            "start_after": {"type": "integer", "description": "Pagination offset (default 0)."},
        },
        "required": [],
    },
}

# The CRM has no field-projection support for quotes — every record includes
# a couple of huge HTML blobs (purchase_terms can run 30KB+, comments_to_buyer
# a few KB) that aren't useful in chat. Trim client-side instead.
_KEEP_FIELDS = (
    "_id",
    "quote_name",
    "quote_status",
    "client_approval_status",
    "quote_amount",
    "currency",
    "expiration_date",
    "date_created",
    "ticket_number",
    "deal",
    "quote_owner",
    "client_details",
)


def _trim(quote: dict) -> dict:
    return {k: quote[k] for k in _KEEP_FIELDS if k in quote}


def _fetch_raw_quotes(*, limit=25, search="", start_after=0, deal_id=None, organization_id=None) -> dict:
    """Parsed, trimmed {"count", "quotes"} — used by run() and by the RAG
    business sync job."""
    base_url, api_key = prospectconnect.resolve_credentials(organization_id)
    if not base_url or not api_key:
        return {"count": 0, "quotes": []}

    payload = {"limit": limit, "search": search, "startAfter": start_after}
    if deal_id:
        payload["deal_id"] = deal_id

    body = prospectconnect.post_json(base_url, api_key, "/quotes/getQuotes", payload)
    quotes = [_trim(q) for q in body.get("quotes", []) if isinstance(q, dict)]
    return {"count": body.get("count"), "quotes": quotes}


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    base_url, api_key = prospectconnect.resolve_credentials(organization_id, context.get("user_id", ""))
    if not base_url or not api_key:
        return "No CRM is connected yet. Ask the user to connect one via the Integrations page."

    try:
        result = _fetch_raw_quotes(
            limit=tool_input.get("limit", 25),
            search=tool_input.get("search") or "",
            start_after=tool_input.get("start_after", 0),
            deal_id=tool_input.get("deal_id"),
            organization_id=organization_id,
        )
    except requests.RequestException as exc:
        response = getattr(exc, "response", None)
        if response is not None:
            snippet = response.text[:300] or "(empty body)"
            return f"CRM request failed ({response.status_code}): {snippet}"
        return f"CRM request failed: {exc}"
    except ValueError:
        return "CRM returned a non-JSON response."

    return str(result)