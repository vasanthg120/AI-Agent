import json

from app.integrations import gorilladash

SPEC = {
    "name": "gorilladash_action",
    "description": (
        "Make changes in Gorilla Dash: create a new enquiry (lead) through one of its enquiry forms, update an existing "
        "enquiry's form fields / tracking data, or send an email to a person. These act on real customers. Call first WITHOUT confirmed to get a preview, show it to the user, and "
        "only call again with confirmed=true after the user explicitly agrees. For a lead, use gorilladash_lookup "
        "'forms' / 'form' first to find the form slug and its exact field names."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create_enquiry", "update_enquiry", "send_email"]},
            "confirmed": {"type": "boolean", "description": "true only after the user approved the preview."},
            # create_enquiry
            "enquiry_form_slug": {"type": "string"},
            "first_name": {"type": "string"},
            "last_name": {"type": "string"},
            "email": {"type": "string"},
            "mobile": {"type": "string"},
            "business_name": {"type": "string"},
            "tribe_slug": {"type": "string", "description": "The location the enquiry (or email) belongs to."},
            "tribe_name": {"type": "string", "description": "create_enquiry: the location by name, instead of tribe_slug."},
            "tribe_id": {"type": "string", "description": "send_email: the location by id."},
            "global_id": {"type": "string", "description": "send_email: the location by global id."},
            "notify": {"type": "boolean", "description": "Send Gorilla Dash's usual notifications for the new enquiry."},
            "fields": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "The form's own fields, by their exact names from the form definition.",
            },
            "tracking_data": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "parameter": {"type": "string"},
                        "value": {"type": "string"},
                        "path": {"type": "string"},
                        "session_at": {"type": "string"},
                    },
                    "required": ["parameter", "value"],
                },
                "description": "Marketing tracking (e.g. utm_source). On update it replaces the enquiry's whole tracking set.",
            },
            # update_enquiry
            "enquiry_id": {"type": "string", "description": "update_enquiry: the enquiry's id (from gorilladash_lookup 'enquiries')."},
            "replace_all": {
                "type": "boolean",
                "description": "update_enquiry: only when the enquiry's current fields couldn't be read — allows the update to "
                "replace its whole field set. Never set it without telling the user other fields will be cleared.",
            },
            # send_email
            "person_id": {"type": "string", "description": "The person's Gorilla Dash id (from gorilladash_lookup 'people')."},
            "subject": {"type": "string"},
            "body": {"type": "string", "description": "HTML body."},
        },
        "required": ["action"],
    },
}


def _form_field_names(form: dict) -> set[str]:
    """Field names from a form definition, whatever list key it uses."""
    names: set[str] = set()
    candidates = [form.get(k) for k in ("fields", "form_fields", "questions")]
    for fields in candidates:
        if isinstance(fields, list):
            for field in fields:
                if isinstance(field, dict):
                    for key in ("name", "field_name", "slug", "key"):
                        if field.get(key):
                            names.add(str(field[key]))
                            break
                elif isinstance(field, str):
                    names.add(field)
    return names


def _create_enquiry(client, tool_input: dict) -> str:
    missing = [k for k in ("enquiry_form_slug", "first_name", "last_name", "email") if not tool_input.get(k)]
    if missing:
        return f"Missing: {', '.join(missing)}."
    slug = tool_input["enquiry_form_slug"]
    form = gorilladash.record_of(client.get(f"/api/v1/enquiry-forms/{slug}"))
    allowed = _form_field_names(form)
    extra = tool_input.get("fields") or {}
    # Gorilla Dash silently drops fields whose names don't match the form —
    # refuse them here instead, so nothing the user said gets lost.
    unknown = sorted(name for name in extra if allowed and name not in allowed)
    if unknown:
        return (
            f"These aren't fields on the '{slug}' form and would be silently dropped: {', '.join(unknown)}. "
            f"Its fields are: {', '.join(sorted(allowed)) or '(none)'}."
        )
    payload = {
        "enquiry_form_slug": slug,
        "first_name": tool_input["first_name"],
        "last_name": tool_input["last_name"],
        "email": tool_input["email"],
        **{k: tool_input[k] for k in ("mobile", "business_name", "tribe_slug", "tribe_name", "notify") if tool_input.get(k) not in (None, "")},
        "fields": [{"name": name, "value": value} for name, value in extra.items()],
    }
    if tool_input.get("tracking_data"):
        payload["tracking_data"] = tool_input["tracking_data"]
    if not tool_input.get("confirmed"):
        return "PREVIEW — not created yet. Show this to the user and ask them to confirm:\n" + json.dumps(payload, ensure_ascii=False)
    body = client.post("/api/v1/enquiries", payload)
    created = gorilladash.record_of(body)
    return f"Enquiry created in Gorilla Dash (id {created.get('id', 'unknown')}) for {tool_input['first_name']} {tool_input['last_name']}."


_FIND_PAGES = 10


def _fields_as_dict(value) -> dict[str, str] | None:
    """An enquiry's form fields as {name: value}, from a [{name, value}] list or a plain object."""
    if isinstance(value, dict):
        return {str(k): "" if v is None else str(v) for k, v in value.items()}
    if isinstance(value, list):
        out = {}
        for item in value:
            if isinstance(item, dict) and item.get("name"):
                out[str(item["name"])] = "" if item.get("value") is None else str(item["value"])
        return out
    return None


def _find_enquiry(client, enquiry_id: str) -> dict | None:
    """Gorilla Dash has no "get one enquiry" endpoint — look through the list pages."""
    for rows in client.pages("/api/v1/enquiries", per_page=100, max_pages=_FIND_PAGES):
        for row in rows:
            if str(row.get("id")) == enquiry_id:
                return row
    return None


def _update_enquiry(client, tool_input: dict) -> str:
    enquiry_id = str(tool_input.get("enquiry_id") or "").strip()
    changes = tool_input.get("fields") or {}
    tracking = tool_input.get("tracking_data")
    if not enquiry_id:
        return "Missing: enquiry_id."
    if not changes and not tracking:
        return "Nothing to update — give the fields (and/or tracking_data) to change."

    # PUT replaces the enquiry's WHOLE field set, so start from what it has now.
    current = _find_enquiry(client, enquiry_id) if changes else None
    existing = _fields_as_dict((current or {}).get("fields"))
    if changes and existing is None and not tool_input.get("replace_all"):
        where = "couldn't be found in the latest enquiries" if current is None else "has no readable field list"
        return (
            f"Enquiry {enquiry_id} {where}, so its other form fields can't be kept: Gorilla Dash replaces the whole set on "
            "update, and any field not sent would be cleared. Tell the user; only if they accept that, call again with "
            "replace_all=true."
        )
    payload: dict = {}
    if changes:
        merged = {**(existing or {}), **{str(k): str(v) for k, v in changes.items()}}
        payload["fields"] = [{"name": name, "value": value} for name, value in merged.items()]
    if tracking:
        payload["tracking_data"] = tracking
    if not tool_input.get("confirmed"):
        preview: dict = {"changes": {k: {"from": (existing or {}).get(k, "(empty)"), "to": v} for k, v in changes.items()}}
        notes = []
        if changes and existing is None:
            notes.append("Its current fields couldn't be read — every other field on it will be cleared.")
        if tracking:
            preview["tracking_data"] = tracking
            notes.append("The tracking data sent replaces all of its existing tracking data.")
        return (
            f"PREVIEW — enquiry {enquiry_id} not updated yet. Show this to the user and ask them to confirm:\n"
            + json.dumps(preview, ensure_ascii=False)
            + ("\n" + " ".join(notes) if notes else "")
        )
    client.put(f"/api/v1/enquiries/{enquiry_id}", payload)
    return f"Enquiry {enquiry_id} updated in Gorilla Dash ({', '.join(changes) or 'tracking data'})."


def _send_email(client, tool_input: dict) -> str:
    missing = [k for k in ("person_id", "subject", "body") if not tool_input.get(k)]
    if missing:
        return f"Missing: {', '.join(missing)}."
    payload = {"person_id": tool_input["person_id"], "subject": tool_input["subject"], "body": tool_input["body"]}
    for key in ("tribe_id", "global_id", "tribe_slug"):
        if tool_input.get(key):
            payload[key] = tool_input[key]
    if not tool_input.get("confirmed"):
        return (
            "PREVIEW — not sent yet. Show the user the subject and body and ask them to confirm:\n"
            + json.dumps(payload, ensure_ascii=False)
        )
    body = client.post("/api/v1/people/send-email", payload)
    log_uuid = gorilladash.record_of(body).get("log_uuid") or body.get("log_uuid")
    return f"Email sent through Gorilla Dash{f' (log {log_uuid})' if log_uuid else ''}."


def run(tool_input: dict, context: dict) -> str:
    try:
        client = gorilladash.GorillaDashClient(context.get("organization_id"))
        if tool_input["action"] == "create_enquiry":
            return _create_enquiry(client, tool_input)
        if tool_input["action"] == "update_enquiry":
            return _update_enquiry(client, tool_input)
        return _send_email(client, tool_input)
    except gorilladash.GorillaDashError as exc:
        return str(exc)
