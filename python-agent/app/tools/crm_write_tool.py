"""Creates a follow-up task in a connected Zoho CRM or Salesforce data
source, linked to a deal/contact/account. This is the one write capability
built for the two new OAuth CRM providers (see crm_adapters.py's
ZohoAdapter/SalesforceAdapter, which are read-only sync adapters — this is
separate, direct-to-provider-API code) — deliberately scoped to the single
lowest-risk, clearly non-destructive action (create a task; never delete,
never touch deal value/stage/financial fields) rather than a general CRM
write tool, per the explicit "no unrestricted write access" requirement this
was built under. Every other CRM here (Pantheras/HubSpot/Gorilla Dash) has
its own separate, already-existing write path (crm_deal_tool.py etc., or
gorilladash_action_tool.py) — this tool only activates for provider in
('zoho', 'salesforce').
"""

import json

import requests

from app.integrations import oauth_refresh
from app.tools.crm_source_records_tool import _find_source, _sources

SPEC = {
    "name": "crm_create_task",
    "description": (
        "Create a follow-up task in a connected Zoho CRM or Salesforce data source (e.g. 'call the customer back "
        "Friday', 'send the revised quote'), optionally linked to a deal/contact/account. Call crm_source_records "
        "'sources' first if unsure which CRM is connected, and crm_source_records 'records' first to find the "
        "related record's externalId if linking to one. Call first WITHOUT confirmed to preview the task, show it "
        "to the user, and only call again with confirmed=true after they explicitly agree — this creates a real "
        "task in the customer's CRM."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "source": {"type": "string", "description": "The data source's name or key, e.g. 'zoho' or 'salesforce'."},
            "subject": {"type": "string", "description": "The task's title."},
            "due_date": {"type": "string", "description": "YYYY-MM-DD, optional."},
            "notes": {"type": "string", "description": "Task description/notes, optional."},
            "related_module": {
                "type": "string",
                "enum": ["deals", "contacts", "accounts"],
                "description": "What this task relates to, if anything.",
            },
            "related_external_id": {
                "type": "string",
                "description": "That record's externalId (from crm_source_records 'records') — required if related_module is set.",
            },
            "confirmed": {"type": "boolean", "description": "true only after the user approved the preview."},
        },
        "required": ["source", "subject"],
    },
}


def _zoho_payload(tool_input: dict) -> dict:
    data: dict = {"Subject": tool_input["subject"]}
    if tool_input.get("due_date"):
        data["Due_Date"] = tool_input["due_date"]
    if tool_input.get("notes"):
        data["Description"] = tool_input["notes"]
    related_id = tool_input.get("related_external_id")
    if related_id:
        # Zoho's Tasks module splits "related to" across two polymorphic
        # fields: Who_Id for a person (Contact/Lead), What_Id for everything
        # else (Deal/Account) — not a single generic "related to" field.
        if tool_input.get("related_module") == "contacts":
            data["Who_Id"] = {"id": related_id}
        else:
            data["What_Id"] = {"id": related_id}
    return {"data": [data]}


def _salesforce_payload(tool_input: dict) -> dict:
    data: dict = {"Subject": tool_input["subject"]}
    if tool_input.get("due_date"):
        data["ActivityDate"] = tool_input["due_date"]
    if tool_input.get("notes"):
        data["Description"] = tool_input["notes"]
    related_id = tool_input.get("related_external_id")
    if related_id:
        # Salesforce Task: WhoId for a Contact/Lead, WhatId for anything
        # else (Opportunity/Account) — same split concept as Zoho above,
        # different field names.
        if tool_input.get("related_module") == "contacts":
            data["WhoId"] = related_id
        else:
            data["WhatId"] = related_id
    return data


def run(tool_input: dict, context: dict) -> str:
    organization_id = context.get("organization_id")
    if not organization_id:
        return "No organization context available."

    related_module = tool_input.get("related_module")
    related_id = tool_input.get("related_external_id")
    if related_module and not related_id:
        return "related_external_id is required when related_module is set."

    sources = _sources(organization_id)
    source = _find_source(sources, tool_input.get("source") or "")
    if not source:
        names = ", ".join(s["label"] for s in sources) or "(none connected)"
        return f"No data source matches '{tool_input.get('source')}'. Connected: {names}."

    provider = source.get("provider")
    if provider not in ("zoho", "salesforce"):
        return f"{source['label']} doesn't support creating tasks through HaiVE yet (only Zoho CRM and Salesforce do)."

    creds = oauth_refresh.get_valid_oauth_credentials(provider, organization_id)
    if not creds:
        return f"{source['label']} needs to be reconnected (its access was revoked or expired) — Settings → Integrations → {source['label']} → Connect."

    if provider == "zoho":
        payload = _zoho_payload(tool_input)
        url = f"{creds['oauthMeta'].get('apiDomain') or 'https://www.zohoapis.com'}/crm/v2/Tasks"
        headers = {"Authorization": f"Zoho-oauthtoken {creds['accessToken']}", "Accept": "application/json"}
    else:
        payload = _salesforce_payload(tool_input)
        instance_url = creds["oauthMeta"].get("instanceUrl")
        if not instance_url:
            return f"{source['label']} is missing its instance URL — please reconnect it from Settings → Integrations."
        url = f"{instance_url}/services/data/v59.0/sobjects/Task/"
        headers = {"Authorization": f"Bearer {creds['accessToken']}", "Accept": "application/json"}

    if not tool_input.get("confirmed"):
        return "PREVIEW — not created yet. Show this to the user and ask them to confirm:\n" + json.dumps(payload, ensure_ascii=False)

    response = requests.post(url, json=payload, headers=headers, timeout=15)
    if response.status_code in (401, 403):
        return f"{source['label']} rejected this request (HTTP {response.status_code}) — it may need to be reconnected."
    if response.status_code >= 400:
        return f"{source['label']} couldn't create the task (HTTP {response.status_code}): {response.text[:300]}"

    body = response.json()
    if provider == "zoho":
        result = (body.get("data") or [{}])[0]
        status = (result.get("status") or "").lower()
        if status != "success":
            return f"{source['label']} couldn't create the task: {result.get('message', 'unknown error')}"
        task_id = (result.get("details") or {}).get("id", "unknown")
    else:
        task_id = body.get("id", "unknown")

    return f"Task created in {source['label']} (id {task_id}): \"{tool_input['subject']}\"."
