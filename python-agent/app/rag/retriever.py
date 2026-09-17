from qdrant_client.http import models as qmodels

from app.rag import hybrid_search


def _document_filter(user_id: str) -> qmodels.Filter:
    return qmodels.Filter(
        must=[
            qmodels.FieldCondition(key="source_type", match=qmodels.MatchValue(value="document")),
            qmodels.FieldCondition(key="user_id", match=qmodels.MatchValue(value=user_id)),
        ]
    )


def retrieve(query: str, user_id: str, top_k: int = 5) -> list[dict]:
    return hybrid_search.search(query, _document_filter(user_id), top_k=top_k)


def retrieve_as_context(query: str, user_id: str, top_k: int = 5) -> str:
    hits = retrieve(query, user_id, top_k=top_k)
    if not hits:
        return ""
    return "\n\n".join(f"[{h['filename']}] {h['text']}" for h in hits)


def _finance_document_filter(organization_id: str) -> qmodels.Filter:
    # Deliberately org-wide, not per-uploader-private, unlike _document_filter
    # above — vendor invoices are an organizational asset multiple people in
    # one org legitimately need to see. organization_id scoping alone is what
    # makes this safe (real tenant isolation, unlike CRM's "*" bucket), so
    # requiring user_id too would only under-serve the real use case with no
    # security benefit.
    return qmodels.Filter(
        must=[
            qmodels.FieldCondition(key="source_type", match=qmodels.MatchValue(value="finance_document")),
            qmodels.FieldCondition(key="organization_id", match=qmodels.MatchValue(value=organization_id)),
        ]
    )


def retrieve_finance_documents(query: str, organization_id: str, top_k: int = 5) -> list[dict]:
    return hybrid_search.search(query, _finance_document_filter(organization_id), top_k=top_k)


def retrieve_finance_documents_as_context(query: str, organization_id: str, top_k: int = 5) -> str:
    hits = retrieve_finance_documents(query, organization_id, top_k=top_k)
    if not hits:
        return ""
    return "\n\n".join(f"[{h['filename']}] {h['text']}" for h in hits)


def _business_knowledge_filter(organization_id: str) -> qmodels.Filter:
    # Org-wide, not per-uploader-private — same reasoning as
    # _finance_document_filter above: a catalog/SOP/business profile is an
    # organizational asset multiple people in one org legitimately need.
    return qmodels.Filter(
        must=[
            qmodels.FieldCondition(
                key="source_type",
                match=qmodels.MatchAny(any=["business_knowledge_document", "business_profile"]),
            ),
            qmodels.FieldCondition(key="organization_id", match=qmodels.MatchValue(value=organization_id)),
        ]
    )


def retrieve_business_knowledge(query: str, organization_id: str, top_k: int = 5) -> list[dict]:
    return hybrid_search.search(query, _business_knowledge_filter(organization_id), top_k=top_k)


def retrieve_business_knowledge_as_context(query: str, organization_id: str, top_k: int = 5) -> str:
    hits = retrieve_business_knowledge(query, organization_id, top_k=top_k)
    if not hits:
        return ""
    return "\n\n".join(f"[{h['filename']}] {h['text']}" for h in hits)


def _call_recording_filter(organization_id: str, user_id: str) -> qmodels.Filter:
    # Private to the recording salesperson (BOTH fields required), unlike
    # _finance_document_filter/_business_knowledge_filter above — this
    # matches the EXISTING Mongo access model (CallCopilotController's
    # getSession/listSessions already scope by organizationId AND userId), so
    # a call session is already private to whoever recorded/uploaded it.
    # Scoping the Qdrant search org-wide like Finance/Business Knowledge
    # would let one salesperson's calls surface in every other org member's
    # search results — a privacy regression relative to what the app already
    # does today, not a deliberate access-control decision.
    return qmodels.Filter(
        must=[
            qmodels.FieldCondition(
                key="source_type",
                match=qmodels.MatchAny(any=["call_recording", "call_recording_summary"]),
            ),
            qmodels.FieldCondition(key="organization_id", match=qmodels.MatchValue(value=organization_id)),
            qmodels.FieldCondition(key="user_id", match=qmodels.MatchValue(value=user_id)),
        ]
    )


def retrieve_call_recordings(query: str, organization_id: str, user_id: str, top_k: int = 8) -> list[dict]:
    return hybrid_search.search(query, _call_recording_filter(organization_id, user_id), top_k=top_k)
