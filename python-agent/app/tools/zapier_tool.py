import json

from app.integrations import zapier_mcp

SPEC = {
    "name": "zapier",
    "description": (
        "Use the apps connected in the organization's Zapier account (for example Hoops or Gorilla Dash) through the "
        "actions an administrator enabled for HaiVE. 'actions' lists them per app with the inputs each needs — call it "
        "first; never guess an action name. 'run' runs one. Write actions (create/update/send) change real data: call "
        "'run' WITHOUT confirmed to get a preview, show it to the user, and only call again with confirmed=true after "
        "they explicitly agree. Each successful run uses 2 Zapier tasks. If an app has no read/search actions, say so "
        "plainly — never substitute data from another app or CRM."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["actions", "run"]},
            "app": {"type": "string", "description": "actions: only this app (e.g. 'Hoops')."},
            "tool_name": {"type": "string", "description": "run: the exact action name from 'actions'."},
            "arguments": {"type": "object", "description": "run: the action's inputs, as listed by 'actions'."},
            "confirmed": {"type": "boolean", "description": "run, write actions: true only after the user approved the preview."},
        },
        "required": ["action"],
    },
}


def _describe_inputs(schema: dict) -> str:
    props = (schema or {}).get("properties") or {}
    required = set((schema or {}).get("required") or [])
    if not props:
        return "no inputs"
    return ", ".join(f"{k}{'*' if k in required else ''}" for k in list(props)[:20])


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    if not organization_id:
        return "No organization context available."
    catalog = zapier_mcp.catalog_for(organization_id)
    if not zapier_mcp.connection_token(organization_id):
        return "Zapier isn't connected. An administrator can connect it in Settings → Data Sources."
    if not catalog:
        return "Zapier is connected but its actions haven't been loaded yet — an administrator can press Refresh in Settings → Data Sources."
    if catalog.get("error"):
        return f"The Zapier connection has a problem: {catalog['error']}"
    if catalog.get("mode") == "agentic":
        return (
            "The Zapier MCP server is in Agentic mode, so no fixed actions are exposed to HaiVE. An administrator should "
            "switch it to Managed mode at mcp.zapier.com and enable the actions HaiVE may use."
        )

    tools = catalog.get("tools") or []
    if tool_input["action"] == "actions":
        wanted = (tool_input.get("app") or "").strip().lower()
        chosen = [t for t in tools if not wanted or t["app"].lower() == wanted]
        if not chosen:
            apps = sorted({t["app"] for t in tools})
            return f"No enabled Zapier actions for '{tool_input.get('app')}'. Apps with actions: {', '.join(apps) or 'none'}."
        lines = []
        for app in sorted({t["app"] for t in chosen}):
            app_tools = [t for t in chosen if t["app"] == app]
            reads = [t for t in app_tools if t["kind"] == "read"]
            lines.append(f"{app} (via Zapier) — {len(reads)} read, {len(app_tools) - len(reads)} write action(s)")
            for t in app_tools:
                lines.append(f"  - [{t['kind']}] {t['name']}: {t['title']} — inputs: {_describe_inputs(t['inputSchema'])}")
            if not reads:
                lines.append(f"  (Zapier offers no read/search actions for {app}, so its existing records can't be read this way.)")
        return "\n".join(lines)

    name = tool_input.get("tool_name") or ""
    tool = next((t for t in tools if t["name"] == name), None)
    if not tool:
        return f"'{name}' isn't an enabled Zapier action. Call 'actions' to see the available ones."
    arguments = tool_input.get("arguments") or {}
    if tool["kind"] == "write" and not tool_input.get("confirmed"):
        return (
            f"PREVIEW — not run yet. '{tool['title']}' in {tool['app']} (via Zapier) with:\n"
            + json.dumps(arguments, ensure_ascii=False, indent=2)
            + "\nShow this to the user and ask them to confirm."
        )
    try:
        result = zapier_mcp.call(organization_id, name, arguments)
    except zapier_mcp.ZapierError as exc:
        return str(exc)
    return f"Result from {tool['app']} (via Zapier), '{tool['title']}':\n{result}"
