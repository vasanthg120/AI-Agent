from app.integrations import integration_executor, zapier_mcp
from app.tools import crm_source_records_tool

SPEC = {
    "name": "integration_capabilities",
    "description": (
        "What is connected for this organization and what data/actions each gives: every CRM data source (with what "
        "it holds), the apps reachable through Zapier (with their read and write actions), and custom REST "
        "integrations with their configured resources/endpoints. Answers 'which CRMs are connected' and 'what can I "
        "access from each'. For custom REST integrations it lists "
        "are configured for each (e.g. a connected 'gorilladash' integration might expose a 'enquiries' "
        "resource with a 'list' and 'get' endpoint). Call this BEFORE integration_execute to discover "
        "the exact provider/resource_key/endpoint_key to use — do not guess them. Optionally filter to "
        "one provider by name."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "provider": {
                "type": "string",
                "description": "Optional — narrow the listing to one connected integration's provider name.",
            },
        },
    },
}


def _connected_overview(organization_id: str) -> list[str]:
    """CRM data sources and Zapier apps — the "what's connected and what can I
    access" answer, each clearly separated by source."""
    lines: list[str] = []
    try:
        lines.append(crm_source_records_tool.run({"action": "sources"}, {"organization_id": organization_id}))
    except Exception:  # noqa: BLE001 - overview is best-effort
        pass
    catalog = zapier_mcp.catalog_for(organization_id)
    if zapier_mcp.connection_token(organization_id):
        if not catalog:
            lines.append("Zapier: connected, actions not loaded yet.")
        elif catalog.get("error"):
            lines.append(f"Zapier: connection problem — {catalog['error']}")
        else:
            lines.append("Apps via Zapier (use the 'zapier' tool):")
            for app in catalog.get("apps") or []:
                reads = ", ".join(app["read"]) or "none — existing records can't be read through Zapier"
                writes = ", ".join(app["write"]) or "none"
                lines.append(f"  - {app['app']}: read/search actions: {reads}; write actions: {writes}")
    return lines


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    if not organization_id:
        return "No organization context available."

    overview = [] if tool_input.get("provider") else _connected_overview(organization_id)
    try:
        capabilities = integration_executor.get_capabilities(
            organization_id, context.get("user_id", ""), tool_input.get("provider")
        )
    except Exception as exc:
        return "\n".join(overview + [f"Failed to list custom REST integrations: {exc}"])

    if not capabilities:
        return "\n".join(overview + ["Custom REST integrations: none with resources/endpoints configured."])

    lines = overview + ["Custom REST integrations (use integration_execute):"]
    for entry in capabilities:
        lines.append(f"Provider: {entry['provider']}")
        for resource in entry["resources"]:
            lines.append(f"  Resource '{resource['key']}' ({resource['name']})")
            for ep in resource["endpoints"]:
                desc = f" — {ep['description']}" if ep.get("description") else ""
                lines.append(f"    - endpoint_key='{ep['key']}': {ep['method']} {ep['path']}{desc}")
    return "\n".join(lines)
