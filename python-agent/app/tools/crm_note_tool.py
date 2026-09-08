import requests

from app.integrations import prospectconnect

SPEC = {
    "name": "crm_note",
    "description": (
        "Fetch notes from the CRM for a contact. Optionally narrow "
        "further to notes tied to a specific deal or account."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "contact_id": {"type": "string", "description": "Required — fetch notes for this contact."},
            "deal_id": {"type": "string", "description": "Optional — narrow to notes tied to this deal."},
            "account_id": {"type": "string", "description": "Optional — narrow to notes tied to this account."},
        },
        "required": ["contact_id"],
    },
}

# The CRM embeds a full nested contact/user record on every note (no field
# projection available for this endpoint) — identical and redundant across
# every note for the same contact_id. Drop it; keep the actual note content.
_DROP_FIELDS = ("contact_details", "created_by_detail", "modified_by_detail")


def _fetch_raw_notes(
    contact_id: str, deal_id: str | None = None, account_id: str | None = None, organization_id: str | None = None
) -> list[dict]:
    """Parsed, trimmed note list for one contact — used by run() and by the
    RAG business sync job (called once per contact, in parallel)."""
    base_url, api_key = prospectconnect.resolve_credentials(organization_id)
    if not base_url or not api_key:
        return []

    payload: dict = {"contact_id": contact_id}
    if deal_id:
        payload["deal_ids"] = [deal_id]
    if account_id:
        payload["account_ids"] = [account_id]

    notes = prospectconnect.post_json(base_url, api_key, "/note/getNotes", payload)
    if not isinstance(notes, list):
        return []
    return [
        {k: v for k, v in note.items() if k not in _DROP_FIELDS} if isinstance(note, dict) else note
        for note in notes
    ]


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    base_url, api_key = prospectconnect.resolve_credentials(organization_id, context.get("user_id", ""))
    if not base_url or not api_key:
        return "No CRM is connected yet. Ask the user to connect one via the Integrations page."

    contact_id = tool_input.get("contact_id")
    if not contact_id:
        return "crm_note requires contact_id."

    try:
        notes = _fetch_raw_notes(
            contact_id, tool_input.get("deal_id"), tool_input.get("account_id"), organization_id
        )
    except requests.RequestException as exc:
        response = getattr(exc, "response", None)
        if response is not None:
            snippet = response.text[:300] or "(empty body)"
            return f"CRM request failed ({response.status_code}): {snippet}"
        return f"CRM request failed: {exc}"
    except ValueError:
        return "CRM returned a non-JSON response."

    return str(notes)
