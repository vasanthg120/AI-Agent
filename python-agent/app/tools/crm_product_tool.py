import requests

from app.integrations import prospectconnect

SPEC = {
    "name": "crm_product",
    "description": "List or search products/pricing catalog in the CRM.",
    "input_schema": {
        "type": "object",
        "properties": {
            "search_text": {"type": "string", "description": "Filter by product name."},
            "category": {"type": "string", "description": "Filter by product category."},
            "limit": {"type": "integer", "description": "Max products to return (default 20)."},
            "start_after": {"type": "integer", "description": "Pagination offset (default 0)."},
        },
        "required": [],
    },
}

# The CRM has no field-projection support for products (unlike contacts/deals/
# accounts) — every record includes full HTML descriptions, images, and a
# duplicate nested "local_one_time_details" blob. Trim client-side instead.
_KEEP_FIELDS = ("_id", "name", "unit_amount", "currency", "category", "active", "type", "source_type")


def _trim(product: dict) -> dict:
    return {k: product[k] for k in _KEEP_FIELDS if k in product}


def run(tool_input: dict, context: dict) -> str:
    base_url, api_key = prospectconnect.resolve_credentials(context.get("organization_id"), context.get("user_id", ""))
    if not base_url or not api_key:
        return "No CRM is connected yet. Ask the user to connect one via the Integrations page."

    payload = {
        "limit": tool_input.get("limit", 20),
        "startAfter": tool_input.get("start_after", 0),
    }
    if tool_input.get("search_text"):
        payload["searchText"] = tool_input["search_text"]
    if tool_input.get("category"):
        payload["category"] = tool_input["category"]

    url = f"{base_url.rstrip('/')}/product/get-product-by-pagination"
    try:
        response = requests.post(url, headers={"Authorization": api_key}, json=payload, timeout=15)
    except requests.RequestException as exc:
        return f"CRM request failed: {exc}"

    if not response.ok:
        snippet = response.text[:300] or "(empty body)"
        return f"CRM request failed ({response.status_code}) at {url}: {snippet}"

    try:
        body = response.json()
    except ValueError:
        snippet = response.text[:300] or "(empty body)"
        return f"CRM returned a non-JSON response (HTTP {response.status_code}) at {url}: {snippet}."

    products = [_trim(p) for p in body.get("product", []) if isinstance(p, dict)]
    return str({"count": body.get("count"), "products": products})