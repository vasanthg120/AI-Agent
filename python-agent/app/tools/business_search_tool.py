from qdrant_client.http import models as qmodels

from app.memory import mem0_client
from app.rag import compression, hybrid_search

SPEC = {
    "name": "search_business_context",
    "description": (
        "Search indexed CRM records (contacts, deals, notes, accounts, quotes), the "
        "signed-in user's Outlook mail, shared business documents (SOPs, policies, role "
        "definitions), the organization's business profile and knowledge documents "
        "(catalogs, price lists, brand/marketing materials, internal manuals), and "
        "previously saved long-term memories (facts/preferences saved via the remember "
        "tool) for context relevant to a question. Use this proactively for open-ended or "
        "personalized questions about clients, deals, meetings, correspondence, company "
        "procedures, products/pricing, or the user's known preferences — before or "
        "alongside the specific crm_* / outlook_lookup tools when you need broad context "
        "rather than one exact lookup."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "source": {
                "type": "string",
                "enum": ["all", "crm", "outlook", "document", "memory", "business_knowledge"],
                "description": (
                    "Restrict results to CRM records, Outlook mail, shared documents, saved "
                    "memories, the organization's business profile/knowledge documents, or all "
                    "(default all)."
                ),
            },
        },
        "required": ["query"],
    },
}

# "memory" is handled separately below (mem0_client.search), not through this
# hybrid_search-driven table — Mem0 (app.memory.mem0_client) owns its own
# Qdrant collection with its own point schema, incompatible with the
# source_type-discriminated filtering these entries drive.
_SOURCE_TYPES = {
    "crm": ["crm_contact", "crm_deal", "crm_note", "crm_account", "crm_quote"],
    "outlook": ["outlook_email"],
    "document": ["document"],  # role-source SOPs (user_id="*") and other shared uploads
    "business_knowledge": ["business_knowledge_document", "business_profile"],
}
_SOURCE_TYPES["all"] = (
    _SOURCE_TYPES["crm"] + _SOURCE_TYPES["outlook"] + _SOURCE_TYPES["document"] + _SOURCE_TYPES["business_knowledge"]
)
_VALID_SOURCES = set(_SOURCE_TYPES) | {"memory"}

# Points for these source types carry a real organization_id payload field
# and must be scoped by it (a catalog/profile is an organizational asset,
# not private to its uploader — see app.rag.retriever._business_knowledge_filter).
_ORG_SCOPED_TYPES = set(_SOURCE_TYPES["business_knowledge"])


def _search_filter(source_types: list[str], user_id: str, organization_id: str | None) -> qmodels.Filter | None:
    """What one request may read, built in one place so it can be tested. Three
    separate branches, none of which can reach another business's data:

    - a person's own points (uploads, connected mailbox), matched by their user
      id, which is itself unique to one business (see User.linkedLoginUserId in
      the backend);
    - points shared within a business (user_id "*": CRM records, activated AI role
      documents), which also need that business's organization_id. A shared point
      with no organization_id matches nobody: it fails closed rather than being
      visible to every business;
    - points that are always organization-wide (see _ORG_SCOPED_TYPES).

    The scheduled report path acts as user_id "*" and so only gets the last two.
    """
    scoped = [t for t in source_types if t in _ORG_SCOPED_TYPES]
    unscoped = [t for t in source_types if t not in _ORG_SCOPED_TYPES]
    source = lambda types: qmodels.FieldCondition(key="source_type", match=qmodels.MatchAny(any=types))  # noqa: E731
    in_organization = lambda: qmodels.FieldCondition(key="organization_id", match=qmodels.MatchValue(value=organization_id))  # noqa: E731

    branches = []
    if unscoped and user_id and user_id != "*":
        branches.append(qmodels.Filter(must=[source(unscoped), qmodels.FieldCondition(key="user_id", match=qmodels.MatchValue(value=user_id))]))
    if unscoped and organization_id:
        branches.append(qmodels.Filter(must=[source(unscoped), qmodels.FieldCondition(key="user_id", match=qmodels.MatchValue(value="*")), in_organization()]))
    if scoped and organization_id:
        branches.append(qmodels.Filter(must=[source(scoped), in_organization()]))

    if not branches:
        return None
    return branches[0] if len(branches) == 1 else qmodels.Filter(should=branches)


def run(tool_input: dict, context: dict) -> str:
    query = tool_input.get("query", "")
    if not query:
        return "search_business_context requires a query."

    source = tool_input.get("source", "all")
    if source not in _VALID_SOURCES:
        source = "all"
    user_id = context.get("user_id", "")
    organization_id = context.get("organization_id")
    # Internal-only, never LLM-controlled (tool_input has no such property in
    # its schema above, so a live chat tool call can never set this) — the
    # scheduled report path sets it in its own context dict so a task can
    # optionally be tied back to a real CRM record id (see
    # crew_reports.py/REPORT_EXTRACTION_TOOL). Every other caller (live chat)
    # never sets it, so their formatted output is byte-identical to before.
    include_record_ids = bool(context.get("include_record_ids"))

    # Mem0-backed memories (app.memory.mem0_client) live in their own Qdrant
    # collection, separate from the hybrid_search-driven lookup below —
    # fetched independently and merged into the same numbered output.
    memory_hits: list[str] = []
    if source in ("all", "memory"):
        memory_hits = mem0_client.search(query, user_id, limit=5)

    lines: list[str] = []
    if source != "memory":
        query_filter = _search_filter(_SOURCE_TYPES[source], user_id, organization_id)
        if query_filter is not None:
            hits = hybrid_search.search(query, query_filter, top_k=8)
            # [n] markers are a citation convention (see app.agent.llm_client's
            # SYSTEM_PROMPT) — the model is instructed to keep them next to the
            # claims they support in its final answer.
            lines = []
            for h in hits:
                label = h.get("source_type")
                if include_record_ids and h.get("record_id"):
                    label = f"{label}, id={h.get('record_id')}"
                lines.append(f"({label}) {compression.compress(query, h.get('text', ''))}")

    lines.extend(f"(memory) {text}" for text in memory_hits)
    if not lines:
        return "No relevant CRM or Outlook context found."

    return "\n\n".join(f"[{i}] {line}" for i, line in enumerate(lines, start=1))
