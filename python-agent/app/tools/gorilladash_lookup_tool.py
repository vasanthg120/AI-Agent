import json

from app.integrations import gorilladash

SPEC = {
    "name": "gorilladash_lookup",
    "description": (
        "Read data from Gorilla Dash (the business's website/CRM platform): enquiries (leads), people (contacts), "
        "enquiry forms and their fields, locations ('tribes') — list, find nearest to an address or coordinates, or "
        "one location — reviews, knowledge-base and blog articles, the weekly digest, food menu items and the media "
        "library. Read-only. Money is in cents, except a menu item's default_price, which is in dollars."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "enquiries",
                    "people",
                    "forms",
                    "form",
                    "locations",
                    "find_location",
                    "location",
                    "reviews",
                    "knowledge_articles",
                    "blog_articles",
                    "digest_posts",
                    "menu_items",
                    "media",
                ],
                "description": "What to read. 'form', 'location', and knowledge/blog/menu with 'slug' fetch a single record.",
            },
            "slug": {"type": "string", "description": "Slug or id of a single form, location, article or menu item."},
            "updated_after": {"type": "string", "description": "ISO-8601 with timezone, e.g. 2026-09-01T00:00:00+05:30 (enquiries, people, forms)."},
            "page": {"type": "integer", "minimum": 1},
            "results_per_page": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Default 25."},
            "tribe_slug": {"type": "string", "description": "Limit to one location (reviews, media, blog articles)."},
            "status": {"type": "string", "enum": ["launch", "all", "opening soon"], "description": "Locations filter."},
            "address": {"type": "string", "description": "find_location: search near this address."},
            "tribe_id": {"type": "string", "description": "find_location: a location's id."},
            "global_id": {"type": "string", "description": "find_location: a location's global id."},
            "name": {"type": "string", "description": "find_location: narrow a nearness search by location name."},
            "latitude": {"type": "number"},
            "longitude": {"type": "number"},
            "rating": {"type": "integer", "minimum": 1, "maximum": 5, "description": "Reviews at or above this rating (default 1 = all)."},
            "starred": {"type": "boolean", "description": "Media: only starred items."},
        },
        "required": ["action"],
    },
}

_MAX_CHARS = 8000

_LISTS = {
    "enquiries": "/api/v1/enquiries",
    "people": "/api/v1/people",
    "forms": "/api/v1/enquiry-forms",
    "locations": "/api/v1/tribes",
    "reviews": "/api/v1/reviews",
    "knowledge_articles": "/api/v1/knowledge-articles",
    "blog_articles": "/api/v1/blog-articles",
    "digest_posts": "/api/v1/digest-posts",
    "menu_items": "/api/v1/food-menu-items",
    "media": "/api/v1/media",
}
_SINGLE = {
    "form": "/api/v1/enquiry-forms/{}",
    "location": "/api/v1/tribes/{}",
    "knowledge_articles": "/api/v1/knowledge-articles/{}",
    "blog_articles": "/api/v1/blog-articles/{}",
    "menu_items": "/api/v1/food-menu-items/{}",
}


def _dump(payload) -> str:
    text = json.dumps(payload, ensure_ascii=False, default=str)
    return text if len(text) <= _MAX_CHARS else text[:_MAX_CHARS] + " …(truncated — ask for a smaller page or one record)"


def run(tool_input: dict, context: dict) -> str:
    try:
        client = gorilladash.GorillaDashClient(context.get("organization_id"))
    except gorilladash.GorillaDashError as exc:
        return str(exc)

    action = tool_input["action"]
    slug = (tool_input.get("slug") or "").strip()
    try:
        if action in ("form", "location") and not slug:
            return f"'{action}' needs a slug (use '{'forms' if action == 'form' else 'locations'}' to list them)."
        if slug and action in _SINGLE:
            params = {"status": tool_input.get("status")} if action == "location" else {}
            body = client.get(_SINGLE[action].format(slug), **params)
            return _dump(gorilladash.record_of(body))

        if action == "find_location":
            query: dict = {}
            for key in ("tribe_id", "tribe_slug", "global_id", "address", "latitude", "longitude", "name"):
                if tool_input.get(key) not in (None, ""):
                    query[key] = tool_input[key]
            if not set(query) - {"name"}:
                return "find_location needs a tribe_id / tribe_slug / global_id, an address, or latitude+longitude."
            body = client.post("/api/v1/tribes/search", query, results=tool_input.get("results_per_page") or 5)
            return _dump({"locations": gorilladash.records_of(body)})

        params = {
            "page": tool_input.get("page") or 1,
            # Several lists default to just 5 results — always ask for a useful page.
            "results_per_page": tool_input.get("results_per_page") or 25,
            "updated_after": tool_input.get("updated_after"),
            "tribe_slug": tool_input.get("tribe_slug"),
        }
        if action == "locations":
            params["status"] = tool_input.get("status") or "launch"
        if action == "reviews":
            # The API defaults to 5-star reviews only.
            params["rating"] = tool_input.get("rating") or 1
        if action == "media" and tool_input.get("starred") is not None:
            params["starred"] = "true" if tool_input["starred"] else "false"
        body = client.get(_LISTS[action], **params)
        return _dump({"records": gorilladash.records_of(body), "pagination": body.get("pagination")})
    except gorilladash.GorillaDashError as exc:
        return str(exc)
