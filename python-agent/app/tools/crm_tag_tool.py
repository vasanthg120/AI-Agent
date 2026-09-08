from app.integrations import prospectconnect

SPEC = {
    "name": "crm_tag",
    "description": "List tags defined in the CRM for a given module (e.g. contacts, deals).",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Filter tags by name."},
            "module_name": {
                "type": "string",
                "description": "Which module's tags to list (e.g. 'contact'). Defaults to 'contact'.",
            },
            "limit": {"type": "integer", "description": "Max tags to return (default 25)."},
            "offset": {"type": "integer", "description": "Pagination offset (default 0)."},
        },
        "required": [],
    },
}


def run(tool_input: dict, context: dict) -> str:
    base_url, api_key = prospectconnect.resolve_credentials(context.get("organization_id"), context.get("user_id", ""))
    if not base_url or not api_key:
        return "No CRM is connected yet. Ask the user to connect one via the Integrations page."

    payload = {
        "offset": tool_input.get("offset", 0),
        "limit": tool_input.get("limit", 25),
        "name": tool_input.get("name") or "",
        "module_name": tool_input.get("module_name") or "contact",
    }
    return prospectconnect.post(base_url, api_key, "/tag/fetchTagList", payload)